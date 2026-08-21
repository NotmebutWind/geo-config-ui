const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const form = $('#config-form');
const state = {
  template: null,
  competitors: [],
  questions: [],
  evidenceFacts: [],
  optimizationStandards: [],
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

function getField(name) {
  return form.elements.namedItem(name);
}

function setField(name, value) {
  const field = getField(name);
  if (!field) return;
  if (field.type === 'checkbox') field.checked = Boolean(value);
  else if (Array.isArray(value)) field.value = value.join(name === 'target.seedUrls' || name === 'target.searchQueries' ? '\n' : ', ');
  else field.value = value ?? '';
}

function cleanObject(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== '' && value !== undefined && value !== null));
}

function readRepeatCards(listName) {
  return $$(`[data-list="${listName}"]`).map((card) => {
    const item = {};
    $$('[data-key]', card).forEach((field) => {
      let value = field.value.trim();
      if (field.type === 'number') value = value === '' ? undefined : Number(value);
      item[field.dataset.key] = value;
    });
    return cleanObject(item);
  });
}

function buildConfig() {
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
      seedUrls: splitLines(getField('target.seedUrls').value),
      evidenceFacts: readRepeatCards('evidenceFacts')
    },
    questions: $$('.question-row input').map((input) => input.value.trim()).filter(Boolean),
    competitors: readRepeatCards('competitors'),
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
  const searchQueries = splitLines(getField('target.searchQueries').value);
  if (searchQueries.length) config.target.searchQueries = searchQueries;
  return config;
}

function fillForm(config) {
  const target = config.target || {};
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
  state.competitors = deepClone(config.competitors || []);
  state.questions = deepClone(config.questions || ['']);
  state.evidenceFacts = deepClone(target.evidenceFacts || []);
  state.optimizationStandards = deepClone(config.optimizationStandards || []);
  renderAllLists();
  updatePreview();
}

function updateItemHeadings(listName) {
  $$(`[data-list="${listName}"]`).forEach((card, index) => {
    $('.item-number', card).textContent = String(index + 1).padStart(2, '0');
    const nameInput = $('[data-key="name"]', card);
    const title = $('.item-title', card);
    if (nameInput && title) title.textContent = nameInput.value || (listName === 'competitors' ? '新竞品' : '优化标准');
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
      field.value = item[field.dataset.key] ?? '';
    });
    $('[data-remove]', card).addEventListener('click', () => {
      items.splice(index, 1);
      renderAllLists();
      onFormChange();
    });
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
    row.innerHTML = `<input aria-label="测试问题 ${index + 1}" placeholder="例如：哪款产品更适合 500 人以上的跨国团队？" /><button class="icon-button danger" type="button" aria-label="删除问题">×</button>`;
    $('input', row).value = question;
    $('button', row).addEventListener('click', () => {
      state.questions.splice(index, 1);
      if (!state.questions.length) state.questions.push('');
      renderQuestions();
      onFormChange();
    });
    container.append(row);
  });
}

function renderAllLists() {
  renderCards('competitors', state.competitors, 'competitor-template', 'competitors-list');
  renderCards('evidenceFacts', state.evidenceFacts, 'evidence-template', 'evidenceFacts-list');
  renderCards('optimizationStandards', state.optimizationStandards, 'standard-template', 'optimizationStandards-list');
  renderQuestions();
}

function syncStateFromDom() {
  state.competitors = readRepeatCards('competitors');
  state.evidenceFacts = readRepeatCards('evidenceFacts');
  state.optimizationStandards = readRepeatCards('optimizationStandards');
  state.questions = $$('.question-row input').map((input) => input.value);
}

const sectionChecks = [
  ['项目概览', () => ['name', 'id', 'niche', 'industry', 'product', 'description'].every((name) => getField(name).value.trim())],
  ['目标产品', () => ['target.name', 'target.aliases', 'target.urlPatterns', 'target.seedUrls'].every((name) => getField(name).value.trim())],
  ['竞品信息', () => readRepeatCards('competitors').every((item) => item.name && item.url)],
  ['测试问题', () => $$('.question-row input').some((input) => input.value.trim())],
  ['内部证据', () => true],
  ['高级设置', () => Boolean(getField('generation.systemPrompt').value.trim())]
];

function updateCompletion() {
  const results = sectionChecks.map(([label, check]) => [label, Boolean(check())]);
  const score = Math.round(results.filter(([, done]) => done).length / results.length * 100);
  $('#completion-value').textContent = `${score}%`;
  $('#completion-bar').style.width = `${score}%`;
  $('#completion-list').innerHTML = results.map(([label, done]) => `<li class="${done ? 'done' : ''}">${label}${label === '内部证据' ? '（可选）' : ''}</li>`).join('');
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
}

function saveDraft() {
  localStorage.setItem('geo-config-draft', JSON.stringify({ config: buildConfig(), editingFileName: state.editingFileName }));
  $('#draft-status').textContent = '草稿已自动保存';
}

function localLibrary() {
  try {
    return JSON.parse(localStorage.getItem('geo-config-library') || '[]');
  } catch {
    return [];
  }
}

function saveToLocalLibrary(config, fileName) {
  const items = localLibrary().filter((item) => item.fileName !== fileName);
  items.unshift({ fileName, config, updatedAt: new Date().toISOString() });
  localStorage.setItem('geo-config-library', JSON.stringify(items.slice(0, 30)));
}

function downloadJson(config, fileName) {
  const blob = new Blob([`${JSON.stringify(config, null, 2)}\n`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
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
  syncStateFromDom();
  updateItemHeadings('competitors');
  updateItemHeadings('optimizationStandards');
  updatePreview();
  $('#draft-status').textContent = '正在保存草稿…';
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDraft, 500);
}

function showToast(title, detail = '', type = 'success') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<strong>${title}</strong>${detail ? `<small>${detail}</small>` : ''}`;
  $('#toast-region').append(toast);
  setTimeout(() => toast.remove(), 4200);
}

function validateForm() {
  let firstInvalid = null;
  $$('[required]', form).forEach((field) => {
    const invalid = !field.value.trim();
    field.classList.toggle('invalid', invalid);
    if (invalid && !firstInvalid) firstInvalid = field;
  });
  if (!$$('.question-row input').some((field) => field.value.trim())) {
    const field = $('.question-row input');
    field?.classList.add('invalid');
    firstInvalid ||= field;
  }
  if (firstInvalid) {
    firstInvalid.scrollIntoView({ behavior: 'smooth', block: 'center' });
    firstInvalid.focus({ preventScroll: true });
    showToast('还有必填信息未完成', '已帮你定位到第一个缺失项。', 'error');
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
    if (state.staticMode) {
      const config = buildConfig();
      const fileName = currentFileName();
      downloadJson(config, fileName);
      saveToLocalLibrary(config, fileName);
      state.editingFileName = fileName;
      localStorage.removeItem('geo-config-draft');
      $('#save-title').textContent = '配置已生成并下载';
      $('#save-subtitle').textContent = fileName;
      $('#static-handoff').hidden = false;
      showToast('配置已下载', '下一步可将 JSON 上传到私有项目的 config 目录。');
      await loadConfigList();
      return;
    }
    const response = await fetch('/api/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: currentFileName(), config: buildConfig(), overwrite: state.editingFileName === currentFileName() })
    });
    const result = await response.json();
    if (!response.ok) throw new Error([result.error, ...(result.details || [])].join('；'));
    state.editingFileName = result.fileName;
    localStorage.removeItem('geo-config-draft');
    $('#save-title').textContent = '配置已生成';
    $('#save-subtitle').textContent = result.path;
    showToast('配置创建成功', `${result.path} 已写入项目，可以继续创建下一份。`);
    await loadConfigList();
  } catch (error) {
    showToast('生成失败', error.message, 'error');
  } finally {
    button.disabled = false;
    button.innerHTML = '生成 JSON 配置 <span>→</span>';
  }
}

async function loadConfigList() {
  const container = $('#config-list');
  try {
    if (state.staticMode) {
      const configs = localLibrary();
      container.innerHTML = configs.slice(0, 7).map((item) => `<button class="config-item" type="button" data-file="${item.fileName}"><strong>${item.config.product || item.config.name}</strong><small>${item.fileName} · 本机</small></button>`).join('') || '<p class="muted">本机还没有配置</p>';
      $$('[data-file]', container).forEach((button) => button.addEventListener('click', () => loadExisting(button.dataset.file)));
      return;
    }
    const response = await fetch('/api/configs');
    const { configs } = await response.json();
    container.innerHTML = configs.slice(0, 7).map((config) => `<button class="config-item" type="button" data-file="${config.fileName}"><strong>${config.product || config.name}</strong><small>${config.fileName}</small></button>`).join('') || '<p class="muted">还没有配置</p>';
    $$('[data-file]', container).forEach((button) => button.addEventListener('click', () => loadExisting(button.dataset.file)));
  } catch {
    container.innerHTML = '<p class="muted">暂时无法读取</p>';
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
      $('#save-title').textContent = `正在编辑 ${item.config.product || item.config.target?.name}`;
      $('#save-subtitle').textContent = '再次生成会下载更新后的 JSON';
      window.scrollTo({ top: 0, behavior: 'smooth' });
      showToast('已载入本机配置', item.fileName);
      return;
    }
    const response = await fetch(`/api/configs/${encodeURIComponent(fileName)}`);
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    state.editingFileName = result.fileName;
    state.slugTouched = true;
    fillForm(result.config);
    $('#save-title').textContent = `正在编辑 ${result.config.product || result.config.target?.name}`;
    $('#save-subtitle').textContent = `保存时将更新 config/${result.fileName}`;
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
    target: { name: '', aliases: [], urlPatterns: [], seedUrls: [], evidenceFacts: [] },
    questions: [''], competitors: [],
    optimizationStandards: base.optimizationStandards || [],
    generation: base.generation || {}, probe: base.probe || {}
  });
  state.editingFileName = null;
  state.slugTouched = false;
  localStorage.removeItem('geo-config-draft');
  $('#static-handoff').hidden = true;
  $('#save-title').textContent = '准备好后生成配置';
  $('#save-subtitle').textContent = '文件会写入项目的 config 目录';
  getField('name').focus();
}

function addItem(kind) {
  syncStateFromDom();
  if (kind === 'questions') state.questions.push('');
  if (kind === 'competitors') state.competitors.push({ id: '', name: '', url: '', title: '', content: '' });
  if (kind === 'evidenceFacts') state.evidenceFacts.push({ id: '', sourceUrl: '', verifiedAt: new Date().toISOString().slice(0, 10), fact: '' });
  if (kind === 'optimizationStandards') state.optimizationStandards.push({ id: '', name: '', desc: '', probe: '', actionable: 'content' });
  renderAllLists();
  updatePreview();
  const selector = kind === 'questions' ? '.question-row:last-child input' : `[data-list="${kind}"]:last-child input`;
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
    let result;
    try {
      const response = await fetch('/api/template');
      if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('API unavailable');
      result = await response.json();
      state.template = result.config;
    } catch {
      const response = await fetch('template.json');
      if (!response.ok) throw new Error('无法读取公开版配置模板');
      result = await response.json();
      state.template = result.config;
      state.staticMode = true;
      $('#save-subtitle').textContent = '文件会安全下载到你的电脑';
    }
    const draft = localStorage.getItem('geo-config-draft');
    if (draft) {
      const parsed = JSON.parse(draft);
      state.editingFileName = parsed.editingFileName || null;
      fillForm(parsed.config);
      showToast('已恢复上次草稿', '你可以从离开的地方继续。');
    } else {
      newConfig();
    }
    await loadConfigList();
    setupNavigation();
  } catch (error) {
    showToast('页面初始化失败', error.message, 'error');
  }
}

form.addEventListener('input', onFormChange);
form.addEventListener('change', onFormChange);
getField('target.name').addEventListener('input', () => { getField('target.name').dataset.synced = 'false'; });
$$('[data-add]').forEach((button) => button.addEventListener('click', () => addItem(button.dataset.add)));
$('#save-config').addEventListener('click', saveConfig);
$('#new-config').addEventListener('click', () => newConfig());
$('#refresh-list').addEventListener('click', loadConfigList);
$('#copy-json').addEventListener('click', copyJson);
$('#dialog-copy').addEventListener('click', copyJson);
$('#open-preview').addEventListener('click', () => { updatePreview(); $('#json-dialog').showModal(); });
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $('#json-dialog').close()));
$('#json-dialog').addEventListener('click', (event) => { if (event.target === $('#json-dialog')) $('#json-dialog').close(); });

init();
