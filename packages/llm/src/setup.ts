/**
 * 用户的模型设置 → 实际用哪个模型。顺序：
 *   1. 用户在设置里明确选了的；
 *   2. 用户填了密钥的服务；
 *   3. 部署站点提供的（部署方在环境变量里放的密钥）；
 *   4. 免密钥的免费服务（能连上的话）；
 *   5. 都没有：纯规则。
 */
import { FREE_PRESET_ID, PRESETS, presetById, type ProviderPreset } from './presets.js';
import type { ProviderConfig } from './provider.js';
import type { SiteProvider } from './proxy.js';

export type IntelligenceLevel = 0 | 1 | 2;

export interface ServicePrefs {
  apiKey?: string;
  /** 本地服务和自定义服务的地址 */
  baseUrl?: string;
  /** 上次拉到的模型列表 */
  models?: string[];
}

/** 存在浏览器里的模型设置 */
export interface LlmPrefs {
  level: IntelligenceLevel;
  /** 明确选定的 "服务/模型"；不填就自动挑 */
  model?: string;
  services: Record<string, ServicePrefs>;
}

export type BrainSource = 'chosen' | 'own' | 'site' | 'free' | 'rules';

export interface ResolvedBrain {
  providers: ProviderConfig[];
  /** "服务/模型"；纯规则时为空 */
  defaultModel: string;
  level: IntelligenceLevel;
  source: BrainSource;
}

export const DEFAULT_PREFS: LlmPrefs = { level: 2, services: {} };

/** 浏览器访问这个服务用的地址：允许跨域就直连，否则经本站代理 */
export function endpointFor(preset: ProviderPreset, sp?: ServicePrefs): string {
  if (preset.editableUrl) return (sp?.baseUrl || preset.baseUrl).replace(/\/+$/, '');
  return preset.cors ? preset.baseUrl : `/api/llm/${preset.id}`;
}

/** 这个服务用不用得起来：要密钥的得有密钥，地址可改的得有地址 */
export function serviceReady(preset: ProviderPreset, sp?: ServicePrefs): boolean {
  if (preset.key === 'required' && !sp?.apiKey) return false;
  if (preset.editableUrl && !(sp?.baseUrl || preset.baseUrl)) return false;
  return true;
}

export function presetProvider(preset: ProviderPreset, sp?: ServicePrefs, extraModel?: string): ProviderConfig {
  const models = [...(sp?.models?.length ? sp.models : preset.models)];
  if (extraModel && !models.includes(extraModel)) models.unshift(extraModel);
  return {
    id: preset.id,
    label: preset.label,
    kind: preset.id === 'mock' ? 'mock' : 'openai-compatible',
    baseUrl: endpointFor(preset, sp),
    apiKey: sp?.apiKey || undefined,
    models,
    concurrency: sp?.apiKey && preset.id === FREE_PRESET_ID ? 2 : preset.concurrency,
  };
}

export function siteProvider(s: SiteProvider, suffix: string): ProviderConfig {
  return { id: s.id, label: `${s.label}（${suffix}）`, kind: 'openai-compatible', baseUrl: `/api/llm/site/${s.id}`, models: s.models, env: true, concurrency: s.concurrency };
}

export function splitModel(ref: string): [string, string] {
  const i = ref.indexOf('/');
  return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
}

/**
 * @param site 部署站点提供的服务
 * @param freeOk 免费服务此刻能不能连上（不知道就传 false）
 * @param siteSuffix 站点服务的标签后缀，如"本机密钥""本站提供"
 */
export function resolveBrain(prefs: LlmPrefs, site: SiteProvider[], freeOk: boolean, siteSuffix = '本站提供'): ResolvedBrain {
  const providers: ProviderConfig[] = [];
  const has = (id: string) => providers.some((p) => p.id === id);
  const own: ProviderConfig[] = [];

  // 用户自己填了密钥的
  for (const preset of PRESETS) {
    const sp = prefs.services[preset.id];
    if (preset.key === 'none' || !sp?.apiKey || !serviceReady(preset, sp)) continue;
    const p = presetProvider(preset, sp);
    if (!p.models.length) continue;
    providers.push(p);
    own.push(p);
  }
  // 明确选的服务不需要密钥（本地、免费、假模型）
  const [cid, cmodel] = prefs.model ? splitModel(prefs.model) : ['', ''];
  const chosenPreset = cid ? presetById(cid) : undefined;
  if (chosenPreset && cmodel && !has(cid) && serviceReady(chosenPreset, prefs.services[cid])
    && !(chosenPreset.id === FREE_PRESET_ID && !freeOk && !prefs.services[cid]?.apiKey)) {
    providers.push(presetProvider(chosenPreset, prefs.services[cid], cmodel));
  }
  for (const s of site) if (!has(s.id)) providers.push(siteProvider(s, siteSuffix));
  const free = presetById(FREE_PRESET_ID)!;
  if (freeOk && !has(free.id)) providers.push(presetProvider(free, prefs.services[free.id]));

  const pick = (source: BrainSource, p: ProviderConfig, model = p.models[0]): ResolvedBrain => {
    if (!p.models.includes(model)) p.models.unshift(model);
    return { providers, defaultModel: `${p.id}/${model}`, level: prefs.level, source };
  };
  const chosen = providers.find((p) => p.id === cid);
  // 站点密钥只放行列出的模型
  if (chosen && cmodel && (!chosen.env || chosen.models.includes(cmodel))) return pick('chosen', chosen, cmodel);
  if (own.length) return pick('own', own[0]);
  const s = providers.find((p) => p.env);
  if (s) return pick('site', s);
  const f = providers.find((p) => p.id === free.id);
  if (f) return pick('free', f);
  return { providers, defaultModel: '', level: 0, source: 'rules' };
}

/** 免密钥的免费服务现在能不能连上 */
export async function probeFree(timeoutMs = 5000): Promise<boolean> {
  const free = presetById(FREE_PRESET_ID)!;
  try {
    // 不用缓存：它的 /models 允许缓存几分钟，会把"刚才能连上"当成"现在能连上"
    const res = await fetch(`${free.baseUrl}/models`, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 旧版设置（providers 列表 + defaultModel）迁移过来 */
export function migratePrefs(old: { providers?: ProviderConfig[]; defaultModel?: string; level?: number }): LlmPrefs {
  const prefs: LlmPrefs = { level: (old.level ?? 2) as IntelligenceLevel, services: {} };
  for (const p of old.providers ?? []) {
    if (p.env || !p.apiKey) continue;
    const preset = presetById(p.id);
    if (preset && preset.key !== 'none') prefs.services[p.id] = { apiKey: p.apiKey };
  }
  if (old.defaultModel && !old.defaultModel.startsWith('mock/')) prefs.model = old.defaultModel;
  return prefs;
}
