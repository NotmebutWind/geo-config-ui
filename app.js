import { ConfigImportError, applyReviewPlan, createReviewPlan, parseMachineConfigText, restoreBaseConfig } from './config-import.js';
import { createZipBlob, safeArchiveName } from './zip.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 75 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'csv', 'xls', 'xlsx', 'ppt', 'pptx']);

const form = $('#config-form');
const state = {
  template: null,
  competitors: [],
  questions: [],
  evidenceSources: [],
  evidenceFacts: [],
  optimizationStandards: [],
  officialDocs: [],
  attachments: new Map(),
  preservedOfficial: null,
  machinePlan: null,
  editingFileName: null,
  staticMode: false,
  slugTouched: false,
  saveTimer: null
};

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function splitComma(value) {
  return String(value || '').split(/[,，\n]/).map((item) => item.trim()).filter(Boolean);
}

function splitLines(value) {
  return String(value || '').split('\n').map((item) => item.trim()).filter(Boolean);
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff-]+/g, '-')
    .replace(/[\u4e00-\u9fff]+/g, 'target')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

function newId(prefix) {
  const token = globalThis.crypto?.randomUUID?.().slice(0, 8) || Math.random().toString(16).slice(2, 10);
  return `${prefix}-${token}`;
}

function getField(name) {
  return form.elements.namedItem(name);
}

function currentSourceMode() {
  const value = getField('target.sourceMode')?.value;
  return ['urls', 'docs', 'content'].includes(value) ? value : 'urls';
}

function updateSourcePanels() {
  const mode = currentSourceMode();
  $$('[data-source-panel]').forEach((panel) => {
    panel.hidden = panel.dataset.sourcePanel !== mode;
    if (panel.hidden) $$('.invalid', panel).forEach((field) => field.classList.remove('invalid'));
  });
}

function setField(name, value) {
  const field = getField(name);
  if (!field) return;
  if (field.type === 'checkbox') field.checked = Boolean(value);
  else if (Array.isArray(value)) field.value = value.join(name === 'target.seedUrls' || name === 'target.searchQueries' ? '\n' : ', ');
  else field.value = typeof value === 'string' || typeof value === 'number' ? value : '';
}

function cleanObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== undefined && value !== null));
}

function readRepeatCards(listName) {
  return $$(`[data-list="${listName}"]`).map((card) => {
    const item = {};
    $$('[data-key]', card).forEach((field) => {
      let value = field.value.trim();
      if (field.dataset.array === 'lines') value = splitLines(value);
      else if (field.dataset.array === 'comma') value = splitComma(value);
      else if (field.type === 'number') value = value === '' ? undefined : Number(value);
      item[field.dataset.key] = value;
    });
    return cleanObject(item);
  });
}

function normalizedCompetitors() {
  return readRepeatCards('competitors').map((item) => {
    const seedUrls = [...new Set([...(item.seedUrls || []), item.url].filter(Boolean))];
    return {
      ...item,
      url: item.url || seedUrls[0] || '',
      seedUrls,
      content: item.content || '',
      contentStatus: item.contentStatus || (item.content ? 'reviewed' : 'empty')
    };
  });
}

function buildConfig() {
  const sourceMode = currentSourceMode();
  // 多源配置的文本形式保留（review 修复：模式推断曾静默裁字段）——服务端契约是"至少其一"不互斥，
  // 导入 seedUrls + officialContent 并存的合法配置时，非当前编辑模式的文本字段随配置保留。
  // 官方文档附件不在此列：浏览器不保存文件，需切到「上传官方文档」模式重新选择（state.officialDocs 全程展示）。
  const preserved = state.preservedOfficial || {};
  const config = {
    id: getField('id').value.trim(),
    name: getField('name').value.trim(),
    niche: getField('niche').value.trim(),
    industry: getField('industry').value.trim(),
    product: getField('product').value.trim(),
    description: getField('description').value.trim(),
    target: {
      name: getField('target.name').value.trim(),
      aliases: splitComma(getField('target.aliases').value),
      urlPatterns: splitComma(getField('target.urlPatterns').value),
      seedUrls: sourceMode === 'urls' ? splitLines(getField('target.seedUrls').value) : (preserved.seedUrls || []),
      evidenceSources: readRepeatCards('evidenceSources'),
      evidenceFacts: readRepeatCards('evidenceFacts')
    },
    questions: $$('.question-row input').map((input) => input.value.trim()).filter(Boolean),
    competitors: normalizedCompetitors(),
    optimizationStandards: readRepeatCards('optimizationStandards'),
    generation: {
      systemPrompt: getField('generation.systemPrompt').value,
      topK: Number(getField('generation.topK').value),
      temperature: Number(getField('generation.temperature').value)
    },
    probe: {
      model: getField('probe.model').value.trim(),
      doubaoModel: getField('probe.doubaoModel').value.trim(),
      models: splitComma(getField('probe.models').value),
      temperature: Number(getField('probe.temperature').value),
      forceSearch: getField('probe.forceSearch').checked
    }
  };
  if (sourceMode === 'docs') config.target.officialDocs = state.officialDocs.map((doc) => ({ ...doc }));
  const officialContent = sourceMode === 'content'
    ? getField('target.officialContent').value.trim()
    : String(preserved.officialContent || '').trim();
  if (officialContent) config.target.officialContent = officialContent;
  const searchQueries = splitLines(getField('target.searchQueries').value);
  if (searchQueries.length) config.target.searchQueries = searchQueries;
  return config;
}

function buildProcessingOptions() {
  return {
    summarizeCompetitorsIfEmpty: getField('package.summarizeCompetitorsIfEmpty').checked,
    generateQuestionsIfEmpty: getField('package.generateQuestionsIfEmpty').checked
  };
}

function fillForm(config = {}) {
  const target = config?.target && typeof config.target === 'object' ? config.target : {};
  const values = {
    name: config.name,
    id: config.id,
    niche: config.niche,
    industry: config.industry,
    product: config.product || target.name,
    description: config.description,
    'target.name': target.name,
    'target.aliases': target.aliases,
    'target.urlPatterns': target.urlPatterns,
    'target.seedUrls': target.seedUrls,
    'target.officialContent': target.officialContent,
    'target.searchQueries': target.searchQueries,
    'generation.systemPrompt': config.generation?.systemPrompt,
    'generation.topK': config.generation?.topK ?? 4,
    'generation.temperature': config.generation?.temperature ?? 0.3,
    'probe.model': config.probe?.model,
    'probe.doubaoModel': config.probe?.doubaoModel,
    'probe.models': config.probe?.models,
    'probe.temperature': config.probe?.temperature ?? 0.3,
    'probe.forceSearch': config.probe?.forceSearch ?? true
  };
  Object.entries(values).forEach(([name, value]) => setField(name, value));
  state.competitors = deepClone(Array.isArray(config.competitors) ? config.competitors : []);
  state.questions = deepClone(Array.isArray(config.questions) && config.questions.length ? config.questions : ['']);
  state.evidenceSources = deepClone(Array.isArray(target.evidenceSources) ? target.evidenceSources : []);
  state.evidenceFacts = deepClone(Array.isArray(target.evidenceFacts) ? target.evidenceFacts : []);
  state.optimizationStandards = deepClone(Array.isArray(config.optimizationStandards) ? config.optimizationStandards : []);
  state.officialDocs = deepClone(Array.isArray(target.officialDocs) ? target.officialDocs : []);
  state.attachments.clear();
  state.preservedOfficial = {
    seedUrls: Array.isArray(target.seedUrls) ? [...target.seedUrls] : [],
    officialContent: String(target.officialContent || '')
  };
  const sourceModeField = getField('target.sourceMode');
  if (sourceModeField) {
    const inferred = target.seedUrls?.length ? 'urls' : state.officialDocs.length ? 'docs' : String(target.officialContent || '').trim() ? 'content' : 'urls';
    sourceModeField.value = inferred;
    const modesPresent = [target.seedUrls?.length, state.officialDocs.length, String(target.officialContent || '').trim()].filter(Boolean).length;
    if (modesPresent > 1) {
      showToast('这份配置包含多种官方资料形式', `页面以「${inferred === 'urls' ? '官网链接' : inferred === 'docs' ? '上传官方文档' : '手填内容'}」模式编辑；其余文本形式内容已在配置中保留，上传的官方文档需在文档模式重新选择原文件。`);
    }
  }
  renderAllLists();
  renderOfficialDocs();
  updateSourcePanels();
  updatePreview();
}

function updateItemHeadings(listName) {
  $$(`[data-list="${listName}"]`).forEach((card, index) => {
    $('.item-number', card).textContent = String(index + 1).padStart(2, '0');
    const title = $('.item-title', card);
    const labelField = $('[data-key="name"], [data-key="description"]', card);
    if (title && labelField?.value) title.textContent = labelField.value;
  });
}

function validateAttachment(file) {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';
  if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('仅支持 PDF、Office、TXT、Markdown 和 CSV 文件');
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error('单个附件不能超过 25MB');
  if (!file.size) throw new Error('不能上传空文件');
}

function setupEvidenceSourceCard(card, item) {
  const input = $('[data-attachment]', card);
  const status = $('[data-file-status]', card);
  const idField = $('[data-key="id"]', card);
  if (!idField.value) idField.value = item.id || newId('source');
  const attached = state.attachments.get(idField.value);
  if (attached) status.textContent = `已选择：${attached.name}（${(attached.size / 1048576).toFixed(1)}MB）`;
  else if (item.filePath || item.fileName) status.textContent = `资料记录为 ${item.fileName || item.filePath}；如需重新打包，请再次选择原文件。`;
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      validateAttachment(file);
      const sourceId = idField.value || newId('source');
      idField.value = sourceId;
      state.attachments.set(sourceId, file);
      $('[data-key="fileName"]', card).value = file.name;
      $('[data-key="mimeType"]', card).value = file.type || 'application/octet-stream';
      $('[data-key="filePath"]', card).value = `attachments/${safeArchiveName(file.name)}`;
      $('[data-key="status"]', card).value = 'pending';
      status.textContent = `已选择：${file.name}（${(file.size / 1048576).toFixed(1)}MB），只会写入本地 ZIP。`;
      onFormChange();
    } catch (error) {
      input.value = '';
      showToast('附件未加入', error.message, 'error');
    }
  });
}

function renderOfficialDocs() {
  const list = $('#official-docs-list');
  list.innerHTML = '';
  state.officialDocs.forEach((doc) => {
    const item = document.createElement('li');
    item.className = 'doc-item';
    const file = state.attachments.get(doc.id);
    const name = document.createElement('span');
    name.className = 'doc-name';
    name.textContent = doc.fileName || doc.filePath || doc.id;
    const status = document.createElement('small');
    if (file) {
      status.textContent = `${(file.size / 1048576).toFixed(1)}MB · 只写入本地 ZIP`;
    } else {
      status.textContent = '浏览器不保存文件，请移除后重新选择';
      status.className = 'doc-stale';
    }
    const remove = document.createElement('button');
    remove.className = 'icon-button danger';
    remove.type = 'button';
    remove.setAttribute('aria-label', `移除文档 ${doc.fileName || doc.id}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.attachments.delete(doc.id);
      state.officialDocs = state.officialDocs.filter((entry) => entry.id !== doc.id);
      renderOfficialDocs();
      onFormChange();
    });
    item.append(name, status, remove);
    list.append(item);
  });
}

function addOfficialDocFiles(fileList) {
  const rejected = [];
  for (const file of [...(fileList || [])]) {
    try {
      validateAttachment(file);
      const id = newId('doc');
      state.attachments.set(id, file);
      state.officialDocs.push({ id, fileName: file.name, mimeType: file.type || 'application/octet-stream', status: 'pending' });
    } catch (error) {
      rejected.push(`${file.name}：${error.message}`);
    }
  }
  renderOfficialDocs();
  onFormChange();
  if (rejected.length) showToast('部分文件未加入', rejected.join('；'), 'error');
}

function setupOfficialDocsDropZone() {
  const drop = $('#official-docs-drop');
  const input = $('#official-docs-input');
  if (!drop || !input) return;
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener('change', () => {
    addOfficialDocFiles(input.files);
    input.value = '';
  });
  ['dragenter', 'dragover'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.remove('drag-over');
  }));
  drop.addEventListener('drop', (event) => addOfficialDocFiles(event.dataTransfer?.files));
}

function setupCompetitorCard(card, item, index) {
  const status = $('[data-summary-status]', card);
  const contentStatus = item.contentStatus || (item.content ? 'reviewed' : 'empty');
  status.className = `summary-status ${contentStatus}`;
  status.textContent = contentStatus === 'generated' ? '机器生成 · 待 PM 确认' : contentStatus === 'reviewed' ? 'PM 已确认' : '摘要选填';
  $('[data-confirm-summary]', card).addEventListener('click', () => {
    syncStateFromDom();
    if (!state.competitors[index]?.content) return showToast('没有可确认的摘要', '', 'error');
    state.competitors[index].contentStatus = 'reviewed';
    renderAllLists();
    updatePreview();
    saveDraft();
    showToast('竞品摘要已确认');
  });
}

function renderCards(listName, items, templateId, containerId) {
  const container = $(`#${containerId}`);
  container.innerHTML = '';
  items.forEach((item, index) => {
    const fragment = $(`#${templateId}`).content.cloneNode(true);
    const card = fragment.querySelector('article');
    card.dataset.list = listName;
    card.dataset.index = String(index);
    $$('[data-key]', card).forEach((field) => {
      const value = item[field.dataset.key];
      field.value = Array.isArray(value) ? value.join(field.dataset.array === 'lines' ? '\n' : ', ') : value ?? '';
    });
    $('[data-remove]', card).addEventListener('click', () => {
      const id = $('[data-key="id"]', card)?.value;
      if (listName === 'evidenceSources' && id) state.attachments.delete(id);
      items.splice(index, 1);
      renderAllLists();
      onFormChange();
    });
    if (listName === 'competitors') setupCompetitorCard(card, item, index);
    if (listName === 'evidenceSources') setupEvidenceSourceCard(card, item);
    container.append(fragment);
  });
  const empty = $(`#${listName}-empty`);
  if (empty) empty.hidden = items.length > 0;
  updateItemHeadings(listName);
}

function renderQuestions() {
  const container = $('#questions-list');
  container.innerHTML = '';
  state.questions.forEach((question, index) => {
    const row = document.createElement('div');
    row.className = 'question-row';
    const input = document.createElement('input');
    input.setAttribute('aria-label', `测试问题 ${index + 1}`);
    input.placeholder = '例如：哪款产品更适合 500 人以上的跨国团队？';
    input.value = typeof question === 'string' ? question : '';
    const remove = document.createElement('button');
    remove.className = 'icon-button danger';
    remove.type = 'button';
    remove.setAttribute('aria-label', '删除问题');
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.questions.splice(index, 1);
      if (!state.questions.length) state.questions.push('');
      renderQuestions();
      onFormChange();
    });
    row.append(input, remove);
    container.append(row);
  });
}

function renderAllLists() {
  renderCards('competitors', state.competitors, 'competitor-template', 'competitors-list');
  renderCards('evidenceSources', state.evidenceSources, 'evidence-source-template', 'evidenceSources-list');
  renderCards('evidenceFacts', state.evidenceFacts, 'evidence-template', 'evidenceFacts-list');
  renderCards('optimizationStandards', state.optimizationStandards, 'standard-template', 'optimizationStandards-list');
  renderQuestions();
}

function syncStateFromDom() {
  state.competitors = normalizedCompetitors();
  state.evidenceSources = readRepeatCards('evidenceSources');
  state.evidenceFacts = readRepeatCards('evidenceFacts');
  state.optimizationStandards = readRepeatCards('optimizationStandards');
  state.questions = $$('.question-row input').map((input) => input.value);
}

const completionGroups = [
  ['项目概览', ['name', 'id', 'niche', 'industry', 'product', 'description']],
  ['目标产品', ['target.name', 'target.aliases', 'target.officialSource']]
];

function isFieldComplete(name) {
  if (name !== 'target.officialSource') return Boolean(getField(name)?.value.trim());
  const mode = currentSourceMode();
  if (mode === 'docs') return state.officialDocs.length > 0 && state.officialDocs.every((doc) => state.attachments.has(doc.id));
  if (mode === 'content') return Boolean(getField('target.officialContent').value.trim());
  return Boolean(getField('target.seedUrls').value.trim());
}

function updateCompletion() {
  const results = completionGroups.map(([label, names]) => {
    const completed = names.filter(isFieldComplete).length;
    return { label, completed, total: names.length, done: completed === names.length };
  });
  const completed = results.reduce((sum, result) => sum + result.completed, 0);
  const total = results.reduce((sum, result) => sum + result.total, 0);
  const score = Math.round(completed / total * 100);
  $('#completion-value').textContent = `${score}%`;
  $('#completion-bar').style.width = `${score}%`;
  const list = $('#completion-list');
  list.innerHTML = '';
  results.forEach(({ label, completed: count, total: groupTotal, done }) => {
    const item = document.createElement('li');
    item.className = done ? 'done' : '';
    item.textContent = `${label}（${count}/${groupTotal}）`;
    list.append(item);
  });
}

function currentFileName() {
  const id = getField('id').value.trim() || 'new-target';
  return `track-${id.replace(/^track-/, '')}.json`;
}

function updatePreview() {
  const config = buildConfig();
  const json = JSON.stringify(config, null, 2);
  $('#filename-preview').textContent = `config/${currentFileName()}`;
  $('#json-preview').textContent = json;
  $('#json-dialog-content').textContent = json;
  updateCompletion();
  updatePrimaryAction();
}

function updatePrimaryAction() {
  const button = $('#save-config');
  if (!button || button.disabled) return;
  button.innerHTML = '生成配置文件 <span>→</span>';
}

function saveDraft() {
  localStorage.setItem('geo-config-draft', JSON.stringify({ config: buildConfig(), processing: buildProcessingOptions(), editingFileName: state.editingFileName }));
  $('#draft-status').textContent = '草稿已自动保存';
}

function localLibrary() {
  try {
    const value = JSON.parse(localStorage.getItem('geo-config-library') || '[]');
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object' && item.config && typeof item.config === 'object') : [];
  } catch {
    return [];
  }
}

function saveToLocalLibrary(config, fileName) {
  const items = localLibrary().filter((item) => item.fileName !== fileName);
  items.unshift({ fileName, config, processing: buildProcessingOptions(), updatedAt: new Date().toISOString() });
  localStorage.setItem('geo-config-library', JSON.stringify(items.slice(0, 30)));
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function sha256(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function downloadOfflinePackage() {
  if (!validateForm()) return false;
  syncStateFromDom();
  const config = buildConfig();
  const referencedIds = new Set([
    ...config.target.evidenceSources.map((source) => source.id),
    ...(config.target.officialDocs || []).map((doc) => doc.id)
  ]);
  const total = [...referencedIds].reduce((sum, id) => sum + (state.attachments.get(id)?.size || 0), 0);
  if (total > MAX_PACKAGE_BYTES) throw new Error('资料包附件总大小不能超过 75MB');
  const entries = [];
  const manifestEntries = [];
  const usedPaths = new Set();
  const packAttachment = async ({ id, fileName, label, manifestKey }) => {
    const file = state.attachments.get(id);
    if (!file) throw new Error(`${label}“${fileName || id}”需要重新选择原文件后才能打包`);
    let archiveName = `${safeArchiveName(id, manifestKey)}-${safeArchiveName(file.name)}`;
    let path = `attachments/${archiveName}`;
    let suffix = 2;
    while (usedPaths.has(path)) {
      archiveName = `${safeArchiveName(id, manifestKey)}-${suffix}-${safeArchiveName(file.name)}`;
      path = `attachments/${archiveName}`;
      suffix += 1;
    }
    usedPaths.add(path);
    const checksum = await sha256(file);
    const meta = { type: 'file', filePath: path, fileName: file.name, mimeType: file.type || 'application/octet-stream', size: file.size, sha256: checksum, status: 'pending' };
    manifestEntries.push({ [manifestKey]: id, originalName: file.name, path, size: file.size, mimeType: meta.mimeType, sha256: checksum });
    entries.push({ name: path, data: file, date: new Date(file.lastModified) });
    return meta;
  };
  for (const source of config.target.evidenceSources) {
    const file = state.attachments.get(source.id);
    if (!file) {
      if (source.type === 'file' || source.filePath) throw new Error(`资料“${source.description || source.id}”需要重新选择原文件后才能打包`);
      continue;
    }
    Object.assign(source, await packAttachment({ id: source.id, fileName: file.name, label: '资料', manifestKey: 'sourceId' }));
  }
  for (const doc of config.target.officialDocs || []) {
    Object.assign(doc, await packAttachment({ id: doc.id, fileName: doc.fileName, label: '官方文档', manifestKey: 'docId' }));
  }
  const configPath = `config/${currentFileName()}`;
  const manifest = {
    schemaVersion: 2,
    packageType: 'geo-config-offline-package',
    targetId: config.id,
    product: config.product,
    createdAt: new Date().toISOString(),
    configPath,
    processing: buildProcessingOptions(),
    attachments: manifestEntries
  };
  entries.unshift(
    { name: configPath, data: `${JSON.stringify(config, null, 2)}\n` },
    { name: 'manifest.json', data: `${JSON.stringify(manifest, null, 2)}\n` }
  );
  const blob = await createZipBlob(entries);
  downloadBlob(blob, `${safeArchiveName(config.id || 'target')}-offline-package.zip`);
  saveToLocalLibrary(config, currentFileName());
  state.editingFileName = currentFileName();
  await loadConfigList();
  $('#static-handoff').hidden = false;
  $('#static-handoff strong').textContent = '把 ZIP 配置包交给私有服务端';
  $('#static-handoff p').textContent = '配置和附件只生成在这一份 ZIP 中，不会上传 GitHub。服务端拆包后会按需补全问题与摘要。';
  $('#static-handoff a').hidden = true;
  showToast('配置文件已下载', `ZIP 中包含一份配置和 ${manifestEntries.length} 个附件。`);
  return true;
}

function onFormChange(event) {
  if (event?.target?.name === 'id') state.slugTouched = true;
  if (event?.target?.name === 'name' && !state.slugTouched) setField('id', slugify(event.target.value));
  if (event?.target?.name === 'product') {
    if (!getField('target.name').value || getField('target.name').dataset.synced !== 'false') {
      setField('target.name', event.target.value);
      getField('target.name').dataset.synced = 'true';
    }
  }
  if (event?.target?.name === 'target.sourceMode') updateSourcePanels();
  syncStateFromDom();
  updateItemHeadings('competitors');
  updateItemHeadings('evidenceSources');
  updateItemHeadings('optimizationStandards');
  updatePreview();
  $('#draft-status').textContent = '正在保存草稿…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDraft, 500);
}

function showToast(title, detail = '', type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  const heading = document.createElement('strong');
  heading.textContent = title;
  toast.append(heading);
  if (detail) {
    const body = document.createElement('small');
    body.textContent = detail;
    toast.append(body);
  }
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 5000);
}

function validateForm() {
  const hasQuestions = $$('.question-row input').some((field) => field.value.trim());
  if (!hasQuestions && !getField('package.generateQuestionsIfEmpty').checked) {
    $('#questions').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('请填写测试问题或开启自动生成', '测试问题可以留空，但需要允许私有服务端补全。', 'error');
    return false;
  }
  const needsManualSummary = !getField('package.summarizeCompetitorsIfEmpty').checked
    && normalizedCompetitors().some((competitor) => !String(competitor.content || '').trim());
  if (needsManualSummary) {
    $('#competitors').scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('竞品摘要尚未完成', '请填写摘要，或开启“由私有服务端补全空白竞品摘要”。', 'error');
    return false;
  }
  let firstInvalid = null;
  let firstInvalidHint = '';
  $$('[required]', form).forEach((field) => {
    const invalid = !field.value.trim();
    field.classList.toggle('invalid', invalid);
    if (invalid && !firstInvalid) firstInvalid = field;
  });
  const sourceMode = currentSourceMode();
  if (sourceMode === 'docs') {
    const drop = $('#official-docs-drop');
    const missingFile = state.officialDocs.some((doc) => !state.attachments.has(doc.id));
    const invalid = !state.officialDocs.length || missingFile;
    drop.classList.toggle('invalid', invalid);
    if (invalid && !firstInvalid) {
      firstInvalid = drop;
      firstInvalidHint = state.officialDocs.length ? '有官方文档缺少原文件，请移除后重新拖拽上传。' : '请至少上传一份官方文档，或改用其他资料形式。';
    }
  } else {
    const field = getField(sourceMode === 'content' ? 'target.officialContent' : 'target.seedUrls');
    const invalid = !field.value.trim();
    field.classList.toggle('invalid', invalid);
    if (invalid && !firstInvalid) {
      firstInvalid = field;
      firstInvalidHint = sourceMode === 'content' ? '请填写官方内容，或改用其他资料形式。' : '请填写至少一个官网或官方文档 URL，或改用其他资料形式。';
    }
  }
  $$('[data-list="competitors"]', form).forEach((card) => {
    const name = $('[data-key="name"]', card);
    const urls = $('[data-key="seedUrls"]', card);
    const valid = name.value.trim() && (urls.value.trim() || $('[data-key="url"]', card).value.trim());
    name.classList.toggle('invalid', !name.value.trim());
    urls.classList.toggle('invalid', !valid);
    if (!valid) firstInvalid ||= !name.value.trim() ? name : urls;
  });
  $$('[data-list="evidenceSources"]', form).forEach((card) => {
    const url = $('[data-key="url"]', card);
    const id = $('[data-key="id"]', card).value;
    const hasFile = state.attachments.has(id) || $('[data-key="filePath"]', card).value;
    const valid = Boolean(url.value.trim() || hasFile);
    url.classList.toggle('invalid', !valid);
    if (!valid) firstInvalid ||= url;
  });
  $$('[data-list="evidenceFacts"]', form).forEach((card) => {
    const fact = $('[data-key="fact"]', card);
    const source = $('[data-key="sourceUrl"]', card);
    const date = $('[data-key="verifiedAt"]', card);
    const any = fact.value.trim() || source.value.trim() || date.value.trim();
    const complete = fact.value.trim() && source.value.trim() && date.value.trim();
    [fact, source, date].forEach((field) => field.classList.toggle('invalid', Boolean(any && !field.value.trim())));
    if (any && !complete) firstInvalid ||= !fact.value.trim() ? fact : !source.value.trim() ? source : date;
  });
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstInvalid.focus({ preventScroll: true });
    showToast('还有信息需要检查', firstInvalidHint || '已定位到第一个缺失或不完整的项目。', 'error');
    return false;
  }
  return true;
}

async function saveConfig() {
  if (!validateForm()) return;
  const button = $('#save-config');
  button.disabled = true;
  button.textContent = '正在生成…';
  try {
    await downloadOfflinePackage();
    localStorage.removeItem('geo-config-draft');
    $('#save-title').textContent = '配置文件已生成';
    $('#save-subtitle').textContent = `${safeArchiveName(buildConfig().id || 'target')}-offline-package.zip`;
  } catch (error) {
    showToast('生成失败', error.message, 'error');
  } finally {
    button.disabled = false;
    updatePrimaryAction();
  }
}

function renderConfigButtons(container, configs, local = false) {
  container.innerHTML = '';
  configs.slice(0, 7).forEach((item) => {
    const config = local ? item.config : item;
    const button = document.createElement('button');
    button.className = 'config-item';
    button.type = 'button';
    button.dataset.file = item.fileName;
    const title = document.createElement('strong');
    title.textContent = config.product || config.name || '未命名配置';
    const detail = document.createElement('small');
    detail.textContent = `${item.fileName}${local ? ' · 本机' : ''}`;
    button.append(title, detail);
    button.addEventListener('click', () => loadExisting(item.fileName));
    container.append(button);
  });
  if (!configs.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = local ? '本机还没有配置' : '还没有配置';
    container.append(empty);
  }
}

async function loadConfigList() {
  const container = $('#config-list');
  try {
    if (state.staticMode) return renderConfigButtons(container, localLibrary(), true);
    const response = await fetch('/api/configs');
    const result = await response.json();
    renderConfigButtons(container, Array.isArray(result.configs) ? result.configs : []);
  } catch {
    container.textContent = '暂时无法读取';
  }
}

async function loadExisting(fileName) {
  try {
    if (state.staticMode) {
      const item = localLibrary().find((entry) => entry.fileName === fileName);
      if (!item) throw new Error('本机没有找到这份配置');
      state.editingFileName = item.fileName;
      state.slugTouched = true;
      fillForm(item.config);
      setField('package.summarizeCompetitorsIfEmpty', item.processing?.summarizeCompetitorsIfEmpty ?? true);
      setField('package.generateQuestionsIfEmpty', item.processing?.generateQuestionsIfEmpty ?? true);
      $('#save-title').textContent = `正在编辑 ${item.config.product || item.config.target?.name || '配置'}`;
      $('#save-subtitle').textContent = '再次生成会下载更新后的 ZIP 配置包';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return showToast('已载入本机配置', item.fileName);
    }
    const response = await fetch(`/api/configs/${encodeURIComponent(fileName)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.editingFileName = result.fileName;
    state.slugTouched = true;
    fillForm(result.config);
    $('#save-title').textContent = `正在编辑 ${result.config.product || result.config.target?.name || '配置'}`;
    $('#save-subtitle').textContent = `生成时会下载包含 config/${result.fileName} 的 ZIP`;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    showToast('已载入配置', result.fileName);
  } catch (error) {
    showToast('载入失败', error.message, 'error');
  }
}

function newConfig({ keepDefaults = true } = {}) {
  const base = keepDefaults ? deepClone(state.template) : {};
  fillForm({
    id: '', name: '', niche: '', industry: '', product: '', description: '',
    target: { name: '', aliases: [], urlPatterns: [], seedUrls: [], evidenceSources: [], evidenceFacts: [] },
    questions: [''], competitors: [],
    optimizationStandards: base.optimizationStandards || [],
    generation: base.generation || {}, probe: base.probe || {}
  });
  setField('package.summarizeCompetitorsIfEmpty', true);
  setField('package.generateQuestionsIfEmpty', true);
  state.editingFileName = null;
  state.slugTouched = false;
  localStorage.removeItem('geo-config-draft');
  $('#static-handoff').hidden = true;
  $('#save-title').textContent = '准备好后生成配置';
  $('#save-subtitle').textContent = '一份 ZIP 会安全下载到你的电脑';
  getField('name').focus();
}

function addItem(kind) {
  syncStateFromDom();
  if (kind === 'questions') state.questions.push('');
  if (kind === 'competitors') state.competitors.push({ id: '', name: '', url: '', seedUrls: [], title: '', content: '', contentStatus: 'empty' });
  if (kind === 'evidenceSources') state.evidenceSources.push({ id: newId('source'), url: '', description: '', status: 'pending' });
  if (kind === 'evidenceFacts') state.evidenceFacts.push({ id: '', sourceUrl: '', verifiedAt: new Date().toISOString().slice(0, 10), fact: '', status: 'verified' });
  if (kind === 'optimizationStandards') state.optimizationStandards.push({ id: '', name: '', desc: '', probe: '', actionable: 'content' });
  renderAllLists();
  updatePreview();
  const selector = kind === 'questions' ? '.question-row:last-child input' : `[data-list="${kind}"]:last-child input:not([type="hidden"])`;
  $(selector)?.focus();
}

async function copyJson() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(buildConfig(), null, 2));
    showToast('JSON 已复制');
  } catch {
    showToast('复制失败', '请在完整预览中手动选择复制。', 'error');
  }
}

function renderMachineReview(plan) {
  const list = $('#machine-review-list');
  list.innerHTML = '';
  plan.items.forEach((item) => {
    const label = document.createElement('label');
    label.className = 'machine-review-item';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.value = item.key;
    const content = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = item.title;
    const source = document.createElement('small');
    source.textContent = item.source;
    const preview = document.createElement('p');
    preview.textContent = item.preview;
    content.append(title, source, preview);
    label.append(checkbox, content);
    list.append(label);
  });
  $('#machine-review-count').textContent = `${plan.items.length} 项待审核 · 默认均未选择`;
}

async function handleMachineConfigFile(file) {
  if (!file) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw new ConfigImportError('JSON 文件不能超过 2MB');
    const uploaded = parseMachineConfigText(await file.text());
    let current = buildConfig();
    if (!current.id && !current.product && !current.target.name) {
      fillForm(restoreBaseConfig(uploaded, state.template));
      current = buildConfig();
      showToast('已恢复基础信息', '页面原本为空，只恢复了白名单内的用户字段；机器生成内容仍需逐项审核。');
    }
    const plan = createReviewPlan(current, uploaded);
    if (!plan.items.length) throw new ConfigImportError('没有找到可审核的竞品摘要、资料来源或可信事实');
    state.machinePlan = plan;
    renderMachineReview(plan);
    $('#machine-review-dialog').showModal();
  } catch (error) {
    showToast('机器配置未载入', error instanceof Error ? error.message : '文件格式不正确', 'error');
  } finally {
    $('#machine-config-file').value = '';
  }
}

function applyMachineReview() {
  const selected = new Set($$('#machine-review-list input:checked').map((input) => input.value));
  if (!selected.size) return showToast('请先勾选已核实的信息', '未勾选的机器内容不会进入配置。', 'error');
  const result = applyReviewPlan(buildConfig(), state.machinePlan, selected);
  state.competitors = result.competitors;
  state.evidenceSources = result.target.evidenceSources;
  state.evidenceFacts = result.target.evidenceFacts;
  renderAllLists();
  updatePreview();
  saveDraft();
  $('#machine-review-dialog').close();
  showToast('已应用审核结果', `${selected.size} 项机器信息已标记为 PM 审核通过。`);
}

function setupNavigation() {
  const links = $$('.section-nav a');
  const observer = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
      links.forEach((link) => link.classList.toggle('active', link.getAttribute('href') === `#${entry.target.id}`));
    });
  }, { rootMargin: '-10% 0px -75% 0px' });
  $$('.form-section').forEach((section) => observer.observe(section));
}

async function init() {
  try {
    try {
      const response = await fetch('/api/template');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('API unavailable');
      state.template = (await response.json()).config;
    } catch {
      const response = await fetch('template.json');
      if (!response.ok) throw new Error('无法读取公开版配置模板');
      state.template = (await response.json()).config;
      state.staticMode = true;
    }
    const draft = localStorage.getItem('geo-config-draft');
    if (draft) {
      try {
        const parsed = JSON.parse(draft);
        if (!parsed?.config || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) throw new Error('invalid draft');
        state.editingFileName = typeof parsed.editingFileName === 'string' ? parsed.editingFileName : null;
        fillForm(parsed.config);
        setField('package.summarizeCompetitorsIfEmpty', parsed.processing?.summarizeCompetitorsIfEmpty ?? true);
        setField('package.generateQuestionsIfEmpty', parsed.processing?.generateQuestionsIfEmpty ?? true);
        showToast('已恢复上次草稿', '附件出于安全原因不会保存在浏览器草稿中，如需打包请重新选择。');
      } catch {
        localStorage.removeItem('geo-config-draft');
        newConfig();
      }
    } else newConfig();
    await loadConfigList();
    setupNavigation();
  } catch (error) {
    showToast('页面初始化失败', error.message, 'error');
  }
}

form.addEventListener('input', onFormChange);
form.addEventListener('change', onFormChange);
setupOfficialDocsDropZone();
getField('target.name').addEventListener('input', () => { getField('target.name').dataset.synced = 'false'; });
$$('[data-add]').forEach((button) => button.addEventListener('click', () => addItem(button.dataset.add)));
$('#save-config').addEventListener('click', saveConfig);
$('#new-config').addEventListener('click', () => newConfig());
$('#refresh-list').addEventListener('click', loadConfigList);
$('#copy-json').addEventListener('click', copyJson);
$('#dialog-copy').addEventListener('click', copyJson);
$('#open-preview').addEventListener('click', () => { updatePreview(); $('#json-dialog').showModal(); });
$('#upload-machine-config').addEventListener('click', () => $('#machine-config-file').click());
$('#machine-config-file').addEventListener('change', (event) => handleMachineConfigFile(event.target.files?.[0]));
$('#select-all-machine-items').addEventListener('click', () => {
  const boxes = $$('#machine-review-list input[type="checkbox"]');
  const shouldSelect = boxes.some((box) => !box.checked);
  boxes.forEach((box) => { box.checked = shouldSelect; });
});
$('#apply-machine-review').addEventListener('click', applyMachineReview);
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $('#json-dialog').close()));
$$('[data-close-machine-dialog]').forEach((button) => button.addEventListener('click', () => $('#machine-review-dialog').close()));
$('#json-dialog').addEventListener('click', (event) => { if (event.target === $('#json-dialog')) $('#json-dialog').close(); });
$('#machine-review-dialog').addEventListener('click', (event) => { if (event.target === $('#machine-review-dialog')) $('#machine-review-dialog').close(); });

init();
