const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 14;
const MAX_NODES = 20000;
const MAX_ARRAY_ITEMS = 500;
const MAX_OBJECT_KEYS = 250;
const MAX_TEXT = 200000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export class ConfigImportError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigImportError';
  }
}

function text(value, max = 2000) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function httpUrl(value) {
  const raw = text(value, 4000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function safeReference(value) {
  const url = httpUrl(value);
  if (url) return url;
  const path = text(value, 2000).replace(/\\/g, '/').replace(/^\/+/, '');
  return path && !path.split('/').some((part) => part === '..') ? path : '';
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function textList(value, maxItems = 100, maxLength = 4000) {
  return unique((Array.isArray(value) ? value : []).map((item) => text(item, maxLength))).slice(0, maxItems);
}

function inspectTree(root) {
  const stack = [{ value: root, depth: 0, path: '$' }];
  let nodes = 0;
  while (stack.length) {
    const { value, depth, path } = stack.pop();
    nodes += 1;
    if (nodes > MAX_NODES) throw new ConfigImportError('JSON 内容过于复杂，请让研发检查生成文件');
    if (depth > MAX_DEPTH) throw new ConfigImportError(`JSON 嵌套过深（${path}）`);
    if (typeof value === 'string' && value.length > MAX_TEXT) throw new ConfigImportError(`JSON 中存在异常长文本（${path}）`);
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) {
      if (value.length > MAX_ARRAY_ITEMS) throw new ConfigImportError(`JSON 数组项目过多（${path}）`);
      value.forEach((item, index) => stack.push({ value: item, depth: depth + 1, path: `${path}[${index}]` }));
      continue;
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_OBJECT_KEYS) throw new ConfigImportError(`JSON 对象字段过多（${path}）`);
    for (const key of keys) {
      if (FORBIDDEN_KEYS.has(key)) throw new ConfigImportError(`JSON 含有禁止字段：${key}`);
      stack.push({ value: value[key], depth: depth + 1, path: `${path}.${key}` });
    }
  }
}

function normalizeCompetitor(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const name = text(value.name, 200);
  if (!name) return null;
  const seedUrls = unique([
    ...(Array.isArray(value.seedUrls) ? value.seedUrls.map(httpUrl) : []),
    httpUrl(value.url)
  ]).slice(0, 20);
  return {
    id: text(value.id, 160) || `comp-imported-${index + 1}`,
    name,
    url: httpUrl(value.url) || seedUrls[0] || '',
    seedUrls,
    title: text(value.title, 1000),
    content: text(value.content, 100000),
    contentStatus: ['generated', 'reviewed'].includes(value.contentStatus) ? value.contentStatus : 'generated'
  };
}

function normalizeSource(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const url = httpUrl(value.url || value.sourceUrl);
  const rawPath = text(value.filePath, 2000).replace(/\\/g, '/').replace(/^\/+/, '');
  const filePath = rawPath.split('/').some((part) => part === '..') ? '' : rawPath;
  if (!url && !filePath) return null;
  return {
    id: text(value.id, 160) || `source-imported-${index + 1}`,
    type: filePath ? 'file' : 'url',
    url,
    filePath,
    description: text(value.description, 4000),
    fileName: text(value.fileName, 500),
    mimeType: text(value.mimeType, 200),
    size: Number.isFinite(value.size) && value.size >= 0 ? Math.floor(value.size) : undefined,
    sha256: /^[a-f0-9]{64}$/i.test(text(value.sha256, 64)) ? text(value.sha256, 64).toLowerCase() : '',
    status: 'pending'
  };
}

function normalizeFact(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const fact = text(value.fact, 50000);
  const sourceUrl = safeReference(value.sourceUrl);
  if (!fact || !sourceUrl) return null;
  const verifiedAt = /^\d{4}-\d{2}-\d{2}$/.test(text(value.verifiedAt, 10)) ? text(value.verifiedAt, 10) : '';
  return {
    id: text(value.id, 160) || `fact-imported-${index + 1}`,
    sourceId: text(value.sourceId, 160),
    sourceUrl,
    verifiedAt,
    fact,
    status: value.status === 'verified' ? 'verified' : 'generated'
  };
}

export function parseMachineConfigText(source) {
  if (typeof source !== 'string') throw new ConfigImportError('请选择 JSON 文本文件');
  if (new TextEncoder().encode(source).byteLength > MAX_JSON_BYTES) throw new ConfigImportError('JSON 文件不能超过 2MB');
  let raw;
  try {
    raw = JSON.parse(source.replace(/^\uFEFF/, ''));
  } catch {
    throw new ConfigImportError('JSON 无法解析，请让研发重新生成文件');
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigImportError('JSON 顶层必须是一个配置对象');
  inspectTree(raw);
  const target = raw.target && typeof raw.target === 'object' && !Array.isArray(raw.target) ? raw.target : {};
  return {
    id: text(raw.id, 160),
    name: text(raw.name, 500),
    niche: text(raw.niche, 1000),
    industry: text(raw.industry, 500),
    product: text(raw.product, 200),
    description: text(raw.description, 10000),
    target: {
      name: text(target.name, 200),
      aliases: textList(target.aliases, 50, 300),
      urlPatterns: textList(target.urlPatterns, 50, 500),
      seedUrls: unique((Array.isArray(target.seedUrls) ? target.seedUrls : []).map(httpUrl)).slice(0, 50),
      searchQueries: textList(target.searchQueries, 100, 2000),
      evidenceSources: (Array.isArray(target.evidenceSources) ? target.evidenceSources : []).map(normalizeSource).filter(Boolean).slice(0, 200),
      evidenceFacts: (Array.isArray(target.evidenceFacts) ? target.evidenceFacts : []).map(normalizeFact).filter(Boolean).slice(0, 300)
    },
    questions: textList(raw.questions, 100, 5000),
    competitors: (Array.isArray(raw.competitors) ? raw.competitors : []).map(normalizeCompetitor).filter(Boolean).slice(0, 100)
  };
}

function identity(value) {
  return text(value, 300).toLocaleLowerCase().replace(/\s+/g, '');
}

function competitorKey(value) {
  return identity(value.id) || identity(value.name);
}

export function createReviewPlan(current, uploaded) {
  const hasCurrentIdentity = Boolean(identity(current?.id) || identity(current?.product) || identity(current?.target?.name));
  if (!hasCurrentIdentity) throw new ConfigImportError('请先打开原始配置，或让页面从机器文件恢复基础信息后再审核');
  const expectedProduct = unique([identity(current?.product), identity(current?.target?.name)]);
  const actualProduct = unique([identity(uploaded?.product), identity(uploaded?.target?.name)]);
  const idMatches = identity(current?.id) && identity(current?.id) === identity(uploaded?.id);
  const productMatches = expectedProduct.some((value) => actualProduct.includes(value));
  if ((expectedProduct.length && actualProduct.length && !productMatches) || (!productMatches && !idMatches)) {
    throw new ConfigImportError(`上传文件属于“${uploaded.product || uploaded.target?.name || uploaded.id || '其他产品'}”，与当前页面目标不一致`);
  }
  const items = [];
  uploaded.competitors.forEach((competitor, index) => {
    if (!competitor.content && !competitor.title && !competitor.seedUrls.length) return;
    items.push({
      key: `competitor:${competitorKey(competitor) || index}`,
      type: 'competitor',
      title: `竞品：${competitor.name}`,
      source: competitor.seedUrls.join('；') || competitor.url || '未提供来源 URL',
      preview: competitor.content || competitor.title || '仅更新竞品来源 URL',
      value: competitor
    });
  });
  uploaded.target.evidenceSources.forEach((source, index) => {
    items.push({
      key: `source:${identity(source.id) || index}`,
      type: 'source',
      title: `资料来源：${source.description || source.fileName || source.url || source.filePath}`,
      source: source.url || source.filePath,
      preview: source.description || '服务端新增或补充的资料来源',
      value: source
    });
  });
  uploaded.target.evidenceFacts.forEach((fact, index) => {
    items.push({
      key: `fact:${identity(fact.id) || index}`,
      type: 'fact',
      title: `可信事实：${fact.id}`,
      source: `${fact.sourceUrl}${fact.verifiedAt ? ` · ${fact.verifiedAt}` : ''}`,
      preview: fact.fact,
      value: fact
    });
  });
  return { uploaded, items };
}

export function restoreBaseConfig(uploaded, defaults = {}) {
  return {
    id: uploaded.id,
    name: uploaded.name,
    niche: uploaded.niche,
    industry: uploaded.industry,
    product: uploaded.product || uploaded.target.name,
    description: uploaded.description,
    target: {
      name: uploaded.target.name,
      aliases: uploaded.target.aliases,
      urlPatterns: uploaded.target.urlPatterns,
      seedUrls: uploaded.target.seedUrls,
      ...(uploaded.target.searchQueries.length ? { searchQueries: uploaded.target.searchQueries } : {}),
      evidenceSources: [],
      evidenceFacts: []
    },
    questions: uploaded.questions.length ? uploaded.questions : [''],
    competitors: uploaded.competitors.map((competitor) => ({
      id: competitor.id,
      name: competitor.name,
      url: competitor.url,
      seedUrls: competitor.seedUrls,
      title: '',
      content: '',
      contentStatus: 'empty'
    })),
    optimizationStandards: Array.isArray(defaults.optimizationStandards) ? defaults.optimizationStandards : [],
    generation: defaults.generation || {},
    probe: defaults.probe || {}
  };
}

function upsertBy(items, incoming, keyFn) {
  const next = items.map((item) => ({ ...item }));
  const index = next.findIndex((item) => keyFn(item) === keyFn(incoming));
  if (index >= 0) next[index] = incoming;
  else next.push(incoming);
  return next;
}

export function applyReviewPlan(current, plan, selectedKeys) {
  const selected = selectedKeys instanceof Set ? selectedKeys : new Set(selectedKeys || []);
  let competitors = (current.competitors || []).map((item) => ({ ...item, seedUrls: [...(item.seedUrls || [])] }));
  let evidenceSources = (current.target?.evidenceSources || []).map((item) => ({ ...item }));
  let evidenceFacts = (current.target?.evidenceFacts || []).map((item) => ({ ...item }));
  for (const item of plan.items) {
    if (!selected.has(item.key)) continue;
    if (item.type === 'competitor') {
      const incoming = item.value;
      const existing = competitors.find((value) => competitorKey(value) === competitorKey(incoming));
      const reviewed = {
        id: existing?.id || incoming.id,
        name: existing?.name || incoming.name,
        url: existing?.url || incoming.url || incoming.seedUrls[0] || '',
        seedUrls: unique([...(existing?.seedUrls || []), ...incoming.seedUrls]),
        title: incoming.title || existing?.title || '',
        content: incoming.content || existing?.content || '',
        contentStatus: 'reviewed'
      };
      competitors = upsertBy(competitors, reviewed, competitorKey);
    } else if (item.type === 'source') {
      evidenceSources = upsertBy(evidenceSources, { ...item.value, status: 'pending' }, (value) => identity(value.id) || identity(value.url || value.filePath));
    } else if (item.type === 'fact') {
      evidenceFacts = upsertBy(evidenceFacts, { ...item.value, status: 'verified' }, (value) => identity(value.id) || identity(`${value.sourceUrl}:${value.fact}`));
    }
  }
  return {
    competitors,
    target: { evidenceSources, evidenceFacts }
  };
}
