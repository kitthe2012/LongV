import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const DATA = path.join(ROOT, 'data');
const PROJECTS = path.join(DATA, 'projects');
const SETTINGS = path.join(DATA, 'settings.json');
const PORT = 3030;

const STAGES = ['script', 'characters', 'environments', 'storyboard', 'video', 'edit'];
const POST_STAGES = ['voice', 'subtitles', 'music', 'export'];
const ALL_STAGES = [...STAGES, ...POST_STAGES];
const stageNames = { script: '剧本', characters: '角色', environments: '环境', storyboard: '分镜', video: '视频', edit: '合成', voice: '配音', subtitles: '字幕', music: '音乐音效', export: '发布导出' };
const COMFY_TIMEOUT_MS = Number(process.env.LONGV_COMFY_TIMEOUT || 240000);
const runtimeLogs = new Map();
const activeComfy = new Map();

async function ensure() {
  await fs.mkdir(PROJECTS, { recursive: true });
  try { await fs.access(SETTINGS); } catch { await writeJson(SETTINGS, { comfyUrl: 'http://127.0.0.1:8188', comfyTimeoutMs: COMFY_TIMEOUT_MS, workflows: {}, bindings: {}, workflow: null, mapping: { promptNode: '', promptField: 'text', negativeNode: '', negativeField: 'text', imageNode: '', imageField: 'image' } }); }
  const files = await fs.readdir(PROJECTS);
  for (const file of files.filter(name => name.endsWith('.json'))) {
    const project = await readJson(path.join(PROJECTS, file));
    if (!project?.stages) continue;
    let changed = false;
    for (const stage of ALL_STAGES) {
      if (project.stages[stage]?.status === 'running') { project.stages[stage].status = 'error'; project.stages[stage].error = 'LongV 上次运行中断，请重新执行此阶段。'; project.stages[stage].finishedAt = new Date().toISOString(); changed = true; }
    }
    if (changed) await saveProject(project);
  }
}
function normalizeSettings(settings = {}) {
  const normalized = { comfyUrl: 'http://127.0.0.1:8188', comfyTimeoutMs: COMFY_TIMEOUT_MS, videoWidth: 576, videoHeight: 1024, videoDurationSec: 5, workflows: {}, bindings: {}, ...settings };
  normalized.comfyTimeoutMs = Math.min(3600000, Math.max(1000, Number(normalized.comfyTimeoutMs) || COMFY_TIMEOUT_MS));
  normalized.videoWidth = Math.max(64, Math.round(Number(normalized.videoWidth) || 576));
  normalized.videoHeight = Math.max(64, Math.round(Number(normalized.videoHeight) || 1024));
  normalized.videoDurationSec = Math.min(120, Math.max(1, Number(normalized.videoDurationSec) || 5));
  normalized.workflows = normalized.workflows || {};
  normalized.bindings = normalized.bindings || {};
  if (normalized.workflow && !normalized.workflows.default) normalized.workflows.default = { name: 'default', workflow: normalized.workflow, mapping: normalized.mapping || {} };
  return normalized;
}
async function readJson(file, fallback = null) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return fallback; } }
async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2), 'utf8'); }
function id() { return crypto.randomUUID(); }
function safeName(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, '_'); }
function projectFile(projectId) { return path.join(PROJECTS, `${safeName(projectId)}.json`); }
function projectLogFile(projectId) { return path.join(PROJECTS, `${safeName(projectId)}.runtime.log`); }
async function getProject(projectId) { return readJson(projectFile(projectId)); }
async function saveProject(project) { project.updatedAt = new Date().toISOString(); await writeJson(projectFile(project.id), project); }
function logEvent(projectId, level, message, meta = {}) {
  const time = new Date().toISOString(); const stage = meta.stage ? ` [${meta.stage}]` : ''; const details = Object.entries(meta).filter(([key]) => key !== 'stage' && meta[key] !== undefined && meta[key] !== '').map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`).join(' '); const line = `[${time}] [${level.toUpperCase()}]${stage} ${message}${details ? ` | ${details}` : ''}`;
  const list = runtimeLogs.get(projectId) || []; list.push(line); while (list.length > 1000) list.shift(); runtimeLogs.set(projectId, list); console.log(`[LongV][${projectId}] ${line}`); fs.appendFile(projectLogFile(projectId), `${line}\n`, 'utf8').catch(() => {}); return line;
}
async function body(req) {
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8'); return raw ? JSON.parse(raw) : {};
}
function json(res, status, value) { const data = JSON.stringify(value); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(data); }
function publicUrl(projectId, file) { return `/api/projects/${projectId}/files/${encodeURIComponent(file)}`; }
function outputFileType(file) { return path.extname(file).slice(1).toLowerCase(); }

function parseScriptPlan(text, fallback) {
  if (!text) return fallback;
  try {
    const cleaned = String(text).replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const shots = parsed.shots || parsed.scenes || parsed.storyboard || fallback.shots;
    const characters = Array.isArray(parsed.characters) ? parsed.characters.map((character, index) => ({ id: character.id || `character-${index + 1}`, name: character.name || `角色${index + 1}`, description: character.description || character.appearance || character.prompt || '' })) : fallback.characters;
    const locations = Array.isArray(parsed.locations || parsed.settings) ? (parsed.locations || parsed.settings).map((location, index) => ({ id: location.id || `location-${index + 1}`, name: location.name || `场景${index + 1}`, description: location.description || location.prompt || '' })) : fallback.locations;
    const normalizedShots = Array.isArray(shots) ? shots.map((shot, index) => ({
      id: index + 1,
      title: shot.title || shot.name || `镜头${index + 1}`,
      action: shot.action || shot.description || shot.content || '',
      duration: Number(shot.duration || shot.seconds || 5),
      prompt: shot.prompt || shot.video_prompt || shot.action || shot.description || '',
      characterIds: shot.characterIds || shot.characters || characters.slice(0, 1).map(character => character.id),
      locationId: shot.locationId || locations.find(location => location.id === shot.location || location.name === shot.location)?.id || locations[0]?.id || '',
      camera: shot.camera || shot.camera_prompt || '',
      dialogue: shot.dialogue || shot.lines || ''
    })) : fallback.shots;
    return { ...fallback, title: parsed.title || parsed.name || fallback.title, logline: parsed.logline || parsed.summary || parsed.story || fallback.logline, characters, locations, shots: normalizedShots.length ? normalizedShots : fallback.shots, dialogue: parsed.dialogue || parsed.lines || [] };
  } catch { return fallback; }
}

function findRuntimeValue(value, pattern) {
  if (!value || typeof value !== 'object') return '';
  for (const [key, item] of Object.entries(value)) {
    if (pattern.test(key) && (typeof item === 'string' || typeof item === 'number')) return String(item);
    const nested = findRuntimeValue(item, pattern); if (nested) return nested;
  }
  return '';
}

function runProcess(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true }); let stderr = ''; let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); }); child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', error => reject(new Error(`无法启动 ${command}。请安装 FFmpeg 或在连接设置中填写 ffmpeg.exe 路径。`)));
    child.on('close', code => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`FFmpeg 执行失败：${stderr.slice(-1200)}`)));
  });
}

async function extractLastFrame(project, videoFile, stage) {
  const settings = normalizeSettings(await readJson(SETTINGS, {}));
  const ffmpeg = project.workflowSettings?.ffmpegPath || settings.ffmpegPath || 'ffmpeg';
  const framePath = path.join(path.dirname(videoFile.localPath), `${path.basename(videoFile.localPath, path.extname(videoFile.localPath))}-last.png`);
  try {
    await runProcess(ffmpeg, ['-y', '-sseof', '-0.1', '-i', videoFile.localPath, '-frames:v', '1', framePath]);
    return { name: path.basename(framePath), type: 'png', localPath: framePath, url: publicUrl(project.id, `${stage}/${path.basename(framePath)}`) };
  } catch { return null; }
}

function makePlan(idea) {
  const clean = String(idea || '').trim() || '一个人在雨夜发现一封改变命运的信';
  const shots = [
    ['开场建立', '交代主角、地点与时间，镜头缓慢推进，制造悬念。'],
    ['发现线索', '主角注意到一个不寻常的物件或声音，表情发生变化。'],
    ['靠近目标', '主角谨慎靠近线索，镜头切换为中近景，动作连续。'],
    ['意外发生', '线索突然产生变化，主角后退或做出本能反应。'],
    ['真相一角', '特写关键物件或人物细节，透露故事的核心信息。'],
    ['冲突升级', '主角必须在两个选择之间做决定，气氛明显变紧张。'],
    ['反转', '出现与观众预期不同的新信息，镜头快速切换。'],
    ['结尾钩子', '主角做出决定，画面留下一个可以继续发展的悬念。']
  ].map((item, index) => ({ id: index + 1, title: item[0], action: item[1], duration: 5, prompt: `${clean}。${item[1]} 电影感，连续动作，保持人物和场景一致。` }));
  const characters = [{ id: 'character-1', name: '主角', description: '外观、年龄、服装由导演台统一确定，保持全片一致。' }];
  const locations = [{ id: 'location-1', name: '主场景', description: '根据故事自动确定的主场景，固定家具、光线和色调。' }];
  return { title: clean.slice(0, 24), logline: clean, characters, locations, shots: shots.map(shot => ({ ...shot, characterIds: characters.map(character => character.id), locationId: locations[0].id })) };
}

function promptFor(project, stage, shot = null, entity = null) {
  const plan = project.plan;
  const story = project.scriptText || plan.logline;
  if (stage === 'characters') return `角色设定图：${story}。当前角色：${entity?.name || '主角'}。${entity?.description || ''} 请设计正面、侧面、半身、全身参考，服装和发型清晰，纯净背景，无文字，无水印，电影写实风格。`;
  if (stage === 'environments') return `环境母图：当前场景为${entity?.name || '主场景'}。${entity?.description || ''} 只生成空场景环境概念图，不出现任何人类、人物、角色、脸、身体、剪影或动物。明确空间布局、建筑与家具、关键道具、时间、天气和光线，画面中不得出现人物主体，电影写实风格，竖屏9:16。`;
  if (stage === 'storyboard' && shot) return `镜头${shot.id}关键帧：${story}。动作：${shot.action}。机位：${shot.camera || '电影感中景'}。对白：${shot.dialogue || '无'}。请生成适合后续图生视频的单个镜头开始画面，保持角色、场景和色彩一致。`;
  if (stage === 'video' && shot) return `${shot.prompt} 故事背景：${story}。镜头编号：${shot.id}/${plan.shots.length}。${shot.camera || ''}。${shot.dialogue ? `对白：${shot.dialogue}。` : ''}竖屏短剧镜头，${shot.duration}秒，镜头运动自然，人物外观和场景布局与参考图一致，不出现字幕、水印或多余人物。`;
  return story;
}

function deepReplace(value, replacements) {
  if (typeof value === 'string') {
    let out = value; for (const [key, replacement] of Object.entries(replacements)) out = out.split(`{{${key}}}`).join(String(replacement ?? ''));
    return out;
  }
  if (Array.isArray(value)) return value.map(v => deepReplace(v, replacements));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepReplace(v, replacements)]));
  return value;
}
function applyMapping(workflow, mapping, values) {
  const result = structuredClone(workflow);
  const set = (nodeId, field, value) => { if (nodeId && result[nodeId]?.inputs && field) result[nodeId].inputs[field] = value; };
  set(mapping.promptNode, mapping.promptField, values.prompt);
  set(mapping.negativeNode, mapping.negativeField, values.negative || 'text, watermark, logo, distorted, low quality');
  if (values.image) {
    set(mapping.imageNode, mapping.imageField, values.image);
    // LongV supplies one stage input image. Detach optional extra image slots
    // that still point at example files from a multi-image template.
    for (const node of Object.values(result)) {
      if (!node?.inputs) continue;
      for (const [field, value] of Object.entries(node.inputs)) {
        if (!/^images\.image_\d+$/i.test(field) || !Array.isArray(value)) continue;
        const sourceNode = result[String(value[0])];
        if (sourceNode?.class_type === 'LoadImage' && String(value[0]) !== String(mapping.imageNode)) {
          node.inputs[field] = null;
        }
      }
    }
  }
  return deepReplace(result, values);
}
function applyVideoSettings(workflow, width, height, frames) {
  for (const node of Object.values(workflow)) {
    if (!node?.inputs || !/video|createvideo|minimaxh3/i.test(String(node.class_type || ''))) continue;
    if (Object.hasOwn(node.inputs, 'width')) node.inputs.width = width;
    if (Object.hasOwn(node.inputs, 'height')) node.inputs.height = height;
    if (Object.hasOwn(node.inputs, 'length')) node.inputs.length = frames;
    if (Object.hasOwn(node.inputs, 'duration')) node.inputs.duration = Math.max(1, Math.round(frames / 24));
  }
}
function framesForVideoDuration(seconds) {
  const base = Math.max(5, Math.round(Number(seconds) * 24));
  return base + (5 - (base % 17) + 17) % 17;
}

function validateWorkflow(workflow) {
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return 'workflow 必须是 API 格式对象';
  const nodes = Object.entries(workflow).filter(([, node]) => node && typeof node === 'object');
  if (!nodes.length) return 'workflow 中没有节点';
  if (nodes.every(([, node]) => !node.inputs || typeof node.inputs !== 'object')) return '这不是 ComfyUI API 格式，请在 ComfyUI 中导出 API JSON';
  return '';
}

function fileMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg' })[ext] || 'application/octet-stream';
}

async function uploadImageToComfy(settings, localPath) {
  const data = await fs.readFile(localPath);
  const form = new FormData();
  form.append('image', new Blob([data], { type: fileMime(localPath) }), path.basename(localPath));
  form.append('overwrite', 'true');
  const response = await comfyFetch(settings.comfyUrl || 'http://127.0.0.1:8188', '/upload/image', { method: 'POST', body: form }, settings.comfyTimeoutMs);
  const uploaded = await response.json();
  if (!uploaded.name) throw new Error(`ComfyUI 图片上传失败：${JSON.stringify(uploaded)}`);
  return uploaded.subfolder ? `${uploaded.subfolder}/${uploaded.name}` : uploaded.name;
}

function firstImageAsset(project, stage, predicate = () => true) {
  const outputs = project.stages?.[stage]?.outputs || [];
  for (const output of outputs) {
    const files = output.files || (output.url ? [output] : []);
    const image = files.find(file => ['png', 'jpg', 'jpeg', 'webp'].includes(String(file.type).toLowerCase()) && file.localPath);
    if (image && predicate(output)) return image;
  }
  return null;
}

function inputAssetForStage(project, stage, shot = null) {
  if (stage === 'storyboard') return firstImageAsset(project, 'environments', output => !shot || output.entityId === shot.locationId) || firstImageAsset(project, 'characters');
  if (stage === 'video' && shot) return firstImageAsset(project, 'storyboard', output => Number(output.shotId) === Number(shot.id)) || firstImageAsset(project, 'environments', output => output.entityId === shot.locationId) || firstImageAsset(project, 'characters');
  if (stage === 'video') return firstImageAsset(project, 'storyboard') || firstImageAsset(project, 'environments') || firstImageAsset(project, 'characters');
  return null;
}

async function comfyFetch(base, endpoint, options = {}, timeoutMs = COMFY_TIMEOUT_MS) {
  const controller = new AbortController();
  const effectiveTimeoutMs = Math.min(3600000, Math.max(1000, Number(timeoutMs) || COMFY_TIMEOUT_MS));
  const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
  let response;
  try { response = await fetch(`${base.replace(/\/$/, '')}${endpoint}`, { ...options, signal: controller.signal }); }
  catch (error) {
    if (error.name === 'AbortError') throw new Error(`ComfyUI 请求超时（${Math.round(effectiveTimeoutMs / 1000)} 秒）：${endpoint}`);
    throw new Error(`无法连接 ComfyUI：${error.message}`);
  } finally { clearTimeout(timer); }
  if (!response.ok) throw new Error(`ComfyUI ${response.status}: ${(await response.text()).slice(0, 1000)}`);
  return response;
}
async function runComfy(project, stage, prompt, shot = null, inputAsset = null) {
  const settings = normalizeSettings(await readJson(SETTINGS, {}));
  settings.comfyUrl = project.workflowSettings?.comfyUrl || settings.comfyUrl;
  settings.comfyTimeoutMs = project.workflowSettings?.comfyTimeoutMs || settings.comfyTimeoutMs;
  settings.videoWidth = project.workflowSettings?.videoWidth || settings.videoWidth;
  settings.videoHeight = project.workflowSettings?.videoHeight || settings.videoHeight;
  settings.videoDurationSec = project.workflowSettings?.videoDurationSec || settings.videoDurationSec;
  if (!/^https?:\/\//i.test(settings.comfyUrl || '')) throw new Error('ComfyUI 地址无效，请填写 http:// 或 https:// 地址。');
  const workflowName = project.workflowSettings?.bindings?.[stage] || settings.bindings?.[stage] || '';
  const selected = settings.workflows?.[workflowName];
  if (!selected?.workflow) throw new Error(`“${stageNames[stage] || stage}”尚未绑定工作流。请在右上角连接设置中导入并绑定。`);
  const workflowError = validateWorkflow(selected.workflow);
  if (workflowError) throw new Error(`“${workflowName}”工作流无效：${workflowError}`);
  const outputMapping = selected.mapping?.outputs || selected.mapping?.outputMapping || {};
  logEvent(project.id, 'info', '准备提交 ComfyUI 工作流', { stage: stageNames[stage] || stage, workflow: workflowName, shot: shot?.id, input: inputAsset?.name || 'none' });
  let comfyImageName = '';
  if (inputAsset?.localPath && selected.mapping?.imageNode) comfyImageName = await uploadImageToComfy(settings, inputAsset.localPath);
  const generatedLatentId = `longv-${project.id}-${shot?.id || 0}-${Date.now()}`;
  const sequence = project.sequence || {};
  const videoWidth = settings.videoWidth;
  const videoHeight = settings.videoHeight;
  const videoDurationSec = stage === 'video' ? settings.videoDurationSec : (shot?.duration || 5);
  const videoFrames = framesForVideoDuration(videoDurationSec);
  const apiWorkflow = applyMapping(selected.workflow, selected.mapping || {}, {
    prompt, negative: '', image: comfyImageName, width: videoWidth, height: videoHeight,
    frames: videoFrames,
    previous_latent_id: sequence.previousLatentId || '', current_latent_id: generatedLatentId,
    shot_index: shot?.id || 0, total_shots: project.plan?.shots?.length || 0,
    previous_frame: sequence.previousFrame || '', previous_video: sequence.previousVideo || ''
  });
  if (stage === 'video') applyVideoSettings(apiWorkflow, videoWidth, videoHeight, videoFrames);
  if (stage === 'environments') {
    const environmentNegative = 'person, people, human, man, woman, child, face, body, portrait, character, crowd, figure, human silhouette';
    for (const node of Object.values(apiWorkflow)) {
      if (!node || typeof node !== 'object' || !node.inputs) continue;
      const title = String(node._meta?.title || node.title || '').toLowerCase();
      if (node.class_type === 'PrimitiveBoolean' && /enhance prompt/.test(title)) node.inputs.value = false;
      if (node.class_type === 'TextEncodeQwenImage21') node.inputs.negative_prompt = environmentNegative;
    }
  }
  const clientId = id();
  activeComfy.set(project.id, { clientId, stage, shotId: shot?.id || null, promptId: '' });
  const submit = await comfyFetch(settings.comfyUrl || 'http://127.0.0.1:8188', '/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: apiWorkflow, client_id: clientId }) }, settings.comfyTimeoutMs);
  let submitted;
  try { submitted = await submit.json(); } catch { throw new Error('ComfyUI 返回的不是有效 JSON，请检查 API 地址。'); }
  if (!submitted.prompt_id) throw new Error(JSON.stringify(submitted));
  activeComfy.get(project.id).promptId = submitted.prompt_id;
  logEvent(project.id, 'info', 'ComfyUI 已接受任务', { stage: stageNames[stage] || stage, workflow: workflowName, shot: shot?.id, promptId: submitted.prompt_id });
  const executionTimeoutSeconds = Math.ceil(settings.comfyTimeoutMs / 1000);
  for (let i = 0; i < executionTimeoutSeconds; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const history = await comfyFetch(settings.comfyUrl || 'http://127.0.0.1:8188', `/history/${submitted.prompt_id}`, {}, settings.comfyTimeoutMs);
    const historyJson = await history.json(); const item = historyJson[submitted.prompt_id];
    if (!item) continue;
    if (item.status?.status_str === 'error' || item.status?.status_str === 'failed') { const errorMessage = item.status.messages?.map(m => JSON.stringify(m)).join('\n') || 'ComfyUI 执行失败'; logEvent(project.id, 'error', 'ComfyUI 任务失败', { stage: stageNames[stage] || stage, shot: shot?.id, promptId: submitted.prompt_id, error: errorMessage }); throw new Error(errorMessage); }
    if (!item.outputs || item.status?.completed !== true) continue;
    const outputDir = path.join(PROJECTS, safeName(project.id), stage); await fs.mkdir(outputDir, { recursive: true }); const files = [];
    for (const [nodeId, nodeOutput] of Object.entries(item.outputs)) {
      const mappedKind = Object.entries(outputMapping).find(([, mappedNode]) => String(mappedNode) === String(nodeId))?.[0]?.replace(/Node$/, '') || '';
      const mediaValues = ['images', 'gifs', 'videos', 'audio'].flatMap(key => { const value = nodeOutput[key]; return Array.isArray(value) ? value : value ? [value] : []; });
      for (const file of mediaValues) {
        const url = `/view?filename=${encodeURIComponent(file.filename)}&subfolder=${encodeURIComponent(file.subfolder || '')}&type=${encodeURIComponent(file.type || 'output')}`;
        const fileResponse = await comfyFetch(settings.comfyUrl || 'http://127.0.0.1:8188', url, {}, settings.comfyTimeoutMs); const buffer = Buffer.from(await fileResponse.arrayBuffer());
        const local = `${Date.now()}-${safeName(file.filename)}`; const localPath = path.join(outputDir, local); await fs.writeFile(localPath, buffer); files.push({ name: local, type: path.extname(local).slice(1).toLowerCase(), nodeId, outputKind: mappedKind, localPath, url: publicUrl(project.id, `${stage}/${local}`) });
      }
      for (const textValue of (nodeOutput.text || [])) {
        const local = `${Date.now()}-${stage}.txt`; const localPath = path.join(outputDir, local); await fs.writeFile(localPath, String(textValue), 'utf8'); files.push({ name: local, type: 'txt', text: String(textValue), nodeId, outputKind: mappedKind, localPath, url: publicUrl(project.id, `${stage}/${local}`) });
      }
    }
    const videoFile = files.find(file => file.outputKind === 'video' || ['mp4', 'webm', 'mov', 'mkv', 'gif'].includes(file.type));
    let imageFile = files.find(file => file.outputKind === 'frame' || file.outputKind === 'image' || ['png', 'jpg', 'jpeg', 'webp'].includes(file.type));
    if (!imageFile && videoFile) { imageFile = await extractLastFrame(project, videoFile, stage); if (imageFile) files.push(imageFile); }
    const latentId = findRuntimeValue(item, /latent[_-]?id|current[_-]?latent/i) || generatedLatentId;
    logEvent(project.id, 'info', 'ComfyUI 任务完成并已保存输出', { stage: stageNames[stage] || stage, shot: shot?.id, promptId: submitted.prompt_id, files: files.length, latent: latentId });
    const textFile = files.find(file => file.outputKind === 'text' || file.type === 'txt');
    return { promptId: submitted.prompt_id, files, runtime: { latentId, text: textFile?.text || '', lastFrame: imageFile?.localPath || '', video: videoFile?.localPath || '' } };
  }
  throw new Error(`ComfyUI 执行超时（超过${executionTimeoutSeconds}秒）。`);
}

async function composeVideos(project) {
  const settings = normalizeSettings(await readJson(SETTINGS, {}));
  const ffmpeg = project.workflowSettings?.ffmpegPath || settings.ffmpegPath || 'ffmpeg';
  const videoStage = project.stages.video || {};
  const records = (videoStage.outputs || []).filter(output => output.files).sort((a, b) => a.shotId - b.shotId);
  const files = records.flatMap(record => record.files || []).filter(file => ['mp4', 'webm', 'mov', 'mkv', 'gif'].includes(String(file.type).toLowerCase()) && file.localPath);
  if (!files.length) throw new Error('没有找到可合成的视频镜头，请先生成视频。');
  const editDir = path.join(PROJECTS, safeName(project.id), 'edit'); await fs.mkdir(editDir, { recursive: true });
  const concatPath = path.join(editDir, 'concat.txt');
  const concatText = files.map(file => `file '${file.localPath.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`).join('\n'); await fs.writeFile(concatPath, concatText, 'utf8');
  const outputPath = path.join(editDir, `short-drama-${Date.now()}.mp4`);
  try {
    await runProcess(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c', 'copy', outputPath]);
  } catch (copyError) {
    await runProcess(ffmpeg, ['-y', '-f', 'concat', '-safe', '0', '-i', concatPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', outputPath]);
  }
  return { name: path.basename(outputPath), type: 'mp4', localPath: outputPath, url: publicUrl(project.id, `edit/${path.basename(outputPath)}`) };
}

function srtTime(seconds) { const ms = Math.max(0, Math.round(seconds * 1000)); const h = String(Math.floor(ms / 3600000)).padStart(2, '0'); const m = String(Math.floor(ms % 3600000 / 60000)).padStart(2, '0'); const s = String(Math.floor(ms % 60000 / 1000)).padStart(2, '0'); return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`; }
async function createSubtitles(project) {
  const dir = path.join(PROJECTS, safeName(project.id), 'subtitles'); await fs.mkdir(dir, { recursive: true }); let cursor = 0; const lines = [];
  for (const shot of project.plan.shots || []) { const text = shot.dialogue || shot.subtitle || shot.action || ''; const start = cursor; cursor += Number(shot.duration || 5); if (text) lines.push(`${lines.length + 1}\n${srtTime(start)} --> ${srtTime(cursor)}\n${text}\n`); }
  const fileName = `short-drama-${Date.now()}.srt`; const localPath = path.join(dir, fileName); await fs.writeFile(localPath, lines.join('\n'), 'utf8'); return { name: fileName, type: 'srt', localPath, url: publicUrl(project.id, `subtitles/${fileName}`) };
}
async function composeFinal(project) {
  const source = (project.stages.edit.outputs || []).find(output => output.localPath)?.localPath || (project.stages.edit.outputs || []).find(output => output.files?.some(file => file.localPath))?.files?.find(file => file.localPath)?.localPath;
  if (!source) throw new Error('没有找到合成视频，请先完成合成阶段。');
  const settings = normalizeSettings(await readJson(SETTINGS, {})); const ffmpeg = project.workflowSettings?.ffmpegPath || settings.ffmpegPath || 'ffmpeg'; const dir = path.join(PROJECTS, safeName(project.id), 'export'); await fs.mkdir(dir, { recursive: true }); const name = `publish-${Date.now()}.mp4`; const outputPath = path.join(dir, name);
  await runProcess(ffmpeg, ['-y', '-i', source, '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p', '-r', '30', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-movflags', '+faststart', outputPath]);
  return { name, type: 'mp4', profile: '1080x1920-H264-AAC', localPath: outputPath, url: publicUrl(project.id, `export/${name}`) };
}

function stagePreflight(project, stage) {
  if (!project.plan) return '项目还没有剧本计划，请先执行剧本阶段。';
  if (stage === 'video' && !(project.stages.storyboard?.outputs || []).some(output => output.shotId)) return '视频阶段需要先完成分镜阶段，确保每个镜头都有自己的关键帧。';
  if (stage === 'edit' && !(project.stages.video?.outputs || []).some(output => output.shotId)) return '合成阶段需要先完成至少一个视频镜头。';
  if (stage === 'voice' && !(project.scriptText || project.plan?.dialogue || project.plan?.shots?.length)) return '配音阶段需要先完成剧本。';
  if (stage === 'subtitles' && !(project.plan?.shots || []).length) return '字幕阶段需要先完成剧本。';
  if (stage === 'music' && !(project.stages.edit?.outputs || []).length) return '音乐音效阶段需要先完成视频合成。';
  if (stage === 'export' && !(project.stages.edit?.outputs || []).length) return '发布导出需要先完成视频合成。';
  return '';
}

async function runStage(project, stage, options = {}) {
  const preflightError = stagePreflight(project, stage); if (preflightError) throw new Error(preflightError);
  const stageState = project.stages[stage] || { status: 'idle', outputs: [], runs: 0 };
  project.cancelRequested = false;
  logEvent(project.id, 'info', '开始执行阶段', { stage: stageNames[stage] || stage, mode: options.allShots ? 'all-shots' : options.shotId ? `shot-${options.shotId}` : 'single' });
  stageState.status = 'running'; stageState.error = ''; stageState.runs = (stageState.runs || 0) + 1; stageState.startedAt = new Date().toISOString(); project.stages[stage] = stageState; await saveProject(project);
  try {
    if (stage === 'script') {
      project.plan = makePlan(project.idea); stageState.outputs = [{ type: 'json', name: 'story-plan.json', data: project.plan }];
      const settings = normalizeSettings(await readJson(SETTINGS, {}));
      if (project.workflowSettings?.bindings?.script || settings.bindings?.script) {
        const result = await runComfy(project, stage, promptFor(project, stage)); stageState.outputs.push(...result.files);
        const scriptText = result.runtime?.text || result.files.find(file => file.type === 'txt')?.text;
        if (scriptText) { project.scriptText = scriptText; project.plan = parseScriptPlan(scriptText, project.plan); stageState.outputs[0] = { type: 'json', name: 'story-plan.json', data: project.plan }; }
      }
      for (const downstream of ALL_STAGES.slice(1)) project.stages[downstream] = { status: 'idle', outputs: [], runs: 0 };
    } else if (stage === 'video') {
      const shots = project.plan.shots || []; const selectedShots = options.resume ? shots.filter(shot => stageState.shots?.[String(shot.id)]?.status !== 'done') : options.allShots ? shots : [shots.find(shot => shot.id === Number(options.shotId)) || shots[0]].filter(Boolean);
      stageState.shots = stageState.shots || {};
      if (options.allShots) { stageState.outputs = []; stageState.shots = {}; project.sequence = {}; }
      for (const shot of selectedShots) {
        if (project.cancelRequested || activeComfy.get(project.id)?.cancelRequested) throw new Error('用户已停止当前任务。');
        const prior = stageState.shots[String(shot.id - 1)] || {};
        project.sequence = { ...(project.sequence || {}), currentShot: shot.id, previousLatentId: prior.latentId || (shot.id === 1 ? '' : project.sequence?.previousLatentId || ''), previousFrame: prior.lastFrame || project.sequence?.previousFrame || '', previousVideo: prior.video || project.sequence?.previousVideo || '' };
        stageState.current = `镜头 ${shot.id}/${shots.length}`; stageState.shots[String(shot.id)] = { status: 'running', prompt: shot.prompt }; await saveProject(project);
        try {
        logEvent(project.id, 'info', '开始生成视频镜头', { stage: stageNames[stage] || stage, shot: shot.id, title: shot.title });
        const result = await runComfy(project, stage, promptFor(project, stage, shot), shot, inputAssetForStage(project, 'video', shot));
          stageState.outputs = stageState.outputs.filter(output => output.shotId !== shot.id); stageState.outputs.push({ type: 'video', shotId: shot.id, promptId: result.promptId, files: result.files, runtime: result.runtime }); stageState.outputs.sort((a, b) => a.shotId - b.shotId);
          stageState.shots[String(shot.id)] = { status: 'done', promptId: result.promptId, latentId: result.runtime.latentId, lastFrame: result.runtime.lastFrame, video: result.runtime.video };
          project.sequence = { ...project.sequence, currentLatentId: result.runtime.latentId, previousLatentId: result.runtime.latentId, previousFrame: result.runtime.lastFrame, previousVideo: result.runtime.video };
        } catch (error) { logEvent(project.id, 'error', '镜头生成失败', { stage: stageNames[stage] || stage, shot: shot.id, error: error.message }); stageState.shots[String(shot.id)] = { status: 'error', error: error.message }; }
        await saveProject(project);
      }
      delete stageState.current; const failed = Object.values(stageState.shots).some(shot => shot.status === 'error'); stageState.status = failed ? 'error' : 'done'; if (failed) stageState.error = '部分镜头生成失败，可单独重试失败镜头。'; stageState.finishedAt = new Date().toISOString(); activeComfy.delete(project.id); logEvent(project.id, failed ? 'error' : 'info', failed ? '视频阶段部分失败' : '视频阶段完成', { stage: stageNames[stage], shots: selectedShots.length }); await saveProject(project); return project;
    } else if (stage === 'characters' || stage === 'environments') {
      const entities = stage === 'characters' ? (project.plan.characters || []) : (project.plan.locations || []);
      stageState.outputs = [];
      for (const entity of entities) {
        logEvent(project.id, 'info', '开始生成资产', { stage: stageNames[stage] || stage, entity: entity.name, entityId: entity.id });
        const result = await runComfy(project, stage, promptFor(project, stage, null, entity), null, null);
        stageState.outputs.push({ type: 'asset', entityId: entity.id, entityName: entity.name, files: result.files, prompt: promptFor(project, stage, null, entity) });
        await saveProject(project);
      }
    } else if (stage === 'storyboard') {
      const shots = project.plan.shots || [];
      stageState.outputs = [];
      for (const shot of shots) {
        logEvent(project.id, 'info', '开始生成分镜关键帧', { stage: stageNames[stage] || stage, shot: shot.id, title: shot.title });
        const result = await runComfy(project, stage, promptFor(project, stage, shot), shot, inputAssetForStage(project, stage, shot));
        stageState.outputs.push({ type: 'storyboard', shotId: shot.id, shotTitle: shot.title, files: result.files, prompt: promptFor(project, stage, shot) });
        await saveProject(project);
      }
    } else if (stage === 'voice' || stage === 'music') {
      const settings = normalizeSettings(await readJson(SETTINGS, {})); const binding = project.workflowSettings?.bindings?.[stage] || settings.bindings?.[stage]; if (!binding) throw new Error(`请在连接设置中为“${stageNames[stage]}”绑定 ComfyUI 工作流。`);
      const prompt = stage === 'voice' ? `请为以下短剧对白生成中文配音，按角色区分声音，输出干净人声：${project.scriptText || (project.plan.shots || []).map(shot => shot.dialogue || '').filter(Boolean).join('\n')}` : `请为以下短剧生成适合的背景音乐和环境音效，不要人声：${project.plan.logline}`;
      const result = await runComfy(project, stage, prompt); stageState.outputs = result.files.map(file => ({ ...file, prompt }));
    } else if (stage === 'subtitles') {
      stageState.outputs = [await createSubtitles(project)];
    } else if (stage === 'edit') {
      const output = await composeVideos(project); stageState.outputs = [{ type: 'video', ...output }];
    } else if (stage === 'export') {
      const output = await composeFinal(project); stageState.outputs = [{ type: 'video', ...output }];
    }
    stageState.status = 'done'; stageState.finishedAt = new Date().toISOString(); activeComfy.delete(project.id); logEvent(project.id, 'info', '阶段执行完成', { stage: stageNames[stage] || stage, outputs: stageState.outputs?.length || 0 }); await saveProject(project); return project;
  } catch (error) { activeComfy.delete(project.id); logEvent(project.id, 'error', '阶段执行失败', { stage: stageNames[stage] || stage, error: error.message }); stageState.status = 'error'; stageState.error = error.message; stageState.finishedAt = new Date().toISOString(); await saveProject(project); throw error; }
}

async function serveFile(res, file, contentType) { try { const data = await fs.readFile(file); res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' }); res.end(data); } catch { res.writeHead(404); res.end('Not found'); } }
const runningJobs = new Map();
async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`); const parts = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/api/health') { const settings = normalizeSettings(await readJson(SETTINGS, {})); const project = url.searchParams.get('projectId') ? await getProject(url.searchParams.get('projectId')) : null; const comfyUrl = project?.workflowSettings?.comfyUrl || settings.comfyUrl; const comfyTimeoutMs = project?.workflowSettings?.comfyTimeoutMs || settings.comfyTimeoutMs; try { await comfyFetch(comfyUrl, '/system_stats', {}, comfyTimeoutMs); return json(res, 200, { ok: true, comfy: 'online', comfyUrl, comfyTimeoutMs, workflows: Object.keys(settings.workflows).length }); } catch (error) { return json(res, 503, { ok: false, comfy: 'offline', comfyUrl, comfyTimeoutMs, error: error.message, workflows: Object.keys(settings.workflows).length }); } }
  if (req.method === 'GET' && url.pathname === '/api/config') { const settings = normalizeSettings(await readJson(SETTINGS, {})); const project = url.searchParams.get('projectId') ? await getProject(url.searchParams.get('projectId')) : null; const bindings = { ...(settings.bindings || {}), ...(project?.workflowSettings?.bindings || {}) }; return json(res, 200, { comfyUrl: project?.workflowSettings?.comfyUrl || settings.comfyUrl, comfyTimeoutMs: project?.workflowSettings?.comfyTimeoutMs || settings.comfyTimeoutMs, videoWidth: project?.workflowSettings?.videoWidth || settings.videoWidth, videoHeight: project?.workflowSettings?.videoHeight || settings.videoHeight, videoDurationSec: project?.workflowSettings?.videoDurationSec || settings.videoDurationSec, ffmpegPath: project?.workflowSettings?.ffmpegPath || settings.ffmpegPath || '', hasWorkflow: Object.keys(settings.workflows).length > 0, workflows: Object.values(settings.workflows).map(w => ({ name: w.name })), bindings, mapping: settings.mapping || {} }); }
  if (req.method === 'POST' && url.pathname === '/api/test-comfy') { const settings = normalizeSettings(await readJson(SETTINGS, {})); const project = url.searchParams.get('projectId') ? await getProject(url.searchParams.get('projectId')) : null; const comfyUrl = url.searchParams.get('url') || project?.workflowSettings?.comfyUrl || settings.comfyUrl; const comfyTimeoutMs = project?.workflowSettings?.comfyTimeoutMs || settings.comfyTimeoutMs; try { await comfyFetch(comfyUrl, '/system_stats', {}, comfyTimeoutMs); return json(res, 200, { ok: true, message: 'ComfyUI 连接正常', comfyUrl, comfyTimeoutMs }); } catch (error) { return json(res, 503, { ok: false, error: error.message, comfyUrl, comfyTimeoutMs }); } }
  if (req.method === 'POST' && url.pathname === '/api/settings') { const input = await body(req); const settings = normalizeSettings(await readJson(SETTINGS, {})); const comfyTimeoutMs = Math.min(3600000, Math.max(1000, Number(input.comfyTimeoutMs) || settings.comfyTimeoutMs)); const videoWidth = Math.max(64, Math.round(Number(input.videoWidth) || settings.videoWidth)); const videoHeight = Math.max(64, Math.round(Number(input.videoHeight) || settings.videoHeight)); const videoDurationSec = Math.min(120, Math.max(1, Number(input.videoDurationSec) || settings.videoDurationSec)); if (input.projectId) { const project = await getProject(input.projectId); if (!project) return json(res, 404, { error: '项目不存在' }); project.workflowSettings = { comfyUrl: input.comfyUrl || '', comfyTimeoutMs, videoWidth, videoHeight, videoDurationSec, ffmpegPath: input.ffmpegPath || '', bindings: input.bindings || {} }; await saveProject(project); return json(res, 200, { ok: true, projectId: project.id, comfyTimeoutMs, videoWidth, videoHeight, videoDurationSec }); } await writeJson(SETTINGS, { ...settings, ...input, comfyTimeoutMs, videoWidth, videoHeight, videoDurationSec, workflows: settings.workflows }); return json(res, 200, { ok: true, comfyTimeoutMs, videoWidth, videoHeight, videoDurationSec }); }
  if (req.method === 'POST' && url.pathname === '/api/workflows') { const input = await body(req); const workflowError = validateWorkflow(input.workflow); if (workflowError) return json(res, 400, { error: workflowError }); const name = String(input.name || '').trim(); if (!name) return json(res, 400, { error: '请给工作流填写名称' }); if (input.stage && !ALL_STAGES.includes(input.stage)) return json(res, 400, { error: '工作流绑定阶段无效' }); const settings = normalizeSettings(await readJson(SETTINGS, {})); settings.workflows[name] = { name, workflow: input.workflow, mapping: input.mapping || {} }; if (input.stage) settings.bindings[input.stage] = name; if (input.projectId && input.stage) { const project = await getProject(input.projectId); if (project) { project.workflowSettings = project.workflowSettings || { comfyUrl: '', bindings: {} }; project.workflowSettings.bindings[input.stage] = name; await saveProject(project); } } await writeJson(SETTINGS, settings); return json(res, 200, { ok: true, name, bindings: settings.bindings }); }
  if (req.method === 'GET' && parts[0] === 'api' && parts[1] === 'workflows' && parts[2]) { const settings = normalizeSettings(await readJson(SETTINGS, {})); const name = decodeURIComponent(parts.slice(2).join('/')); const workflow = settings.workflows?.[name]; if (!workflow) return json(res, 404, { error: '工作流不存在' }); return json(res, 200, workflow); }
  if (req.method === 'DELETE' && parts[0] === 'api' && parts[1] === 'workflows' && parts[2]) { const settings = normalizeSettings(await readJson(SETTINGS, {})); const name = decodeURIComponent(parts.slice(2).join('/')); delete settings.workflows[name]; for (const [stage, bound] of Object.entries(settings.bindings)) if (bound === name) delete settings.bindings[stage]; await writeJson(SETTINGS, settings); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && url.pathname === '/api/workflow') { const input = await body(req); if (!input.workflow || typeof input.workflow !== 'object') return json(res, 400, { error: 'workflow JSON 无效' }); const settings = normalizeSettings(await readJson(SETTINGS, {})); settings.workflows.default = { name: 'default', workflow: input.workflow, mapping: input.mapping || {} }; await writeJson(SETTINGS, settings); return json(res, 200, { ok: true }); }
  if (req.method === 'GET' && url.pathname === '/api/projects') { const files = await fs.readdir(PROJECTS); const projects = []; for (const file of files.filter(f => f.endsWith('.json'))) { const p = await readJson(path.join(PROJECTS, file)); if (p) projects.push(p); } return json(res, 200, projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  if (req.method === 'POST' && url.pathname === '/api/projects') { const input = await body(req); const project = { id: id(), idea: String(input.idea || ''), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), workflowSettings: { comfyUrl: '', ffmpegPath: '', bindings: {} }, plan: makePlan(input.idea), stages: Object.fromEntries(ALL_STAGES.map(stage => [stage, { status: stage === 'script' ? 'done' : 'idle', outputs: [], runs: 0 }])) }; project.stages.script.outputs = [{ type: 'json', name: 'story-plan.json', data: project.plan }]; await saveProject(project); logEvent(project.id, 'info', '项目已创建', { idea: project.idea }); return json(res, 201, project); }
  if (parts[0] === 'api' && parts[1] === 'projects' && parts[2]) {
    const project = await getProject(parts[2]); if (!project) return json(res, 404, { error: '项目不存在' });
    if (req.method === 'GET' && parts.length === 3) return json(res, 200, project);
    if (req.method === 'POST' && parts[3] === 'cancel') { const task = activeComfy.get(project.id); if (!task) return json(res, 200, { ok: true, message: '当前没有正在运行的 ComfyUI 任务', project }); task.cancelRequested = true; try { const settings = normalizeSettings(await readJson(SETTINGS, {})); const comfyUrl = project.workflowSettings?.comfyUrl || settings.comfyUrl; await comfyFetch(comfyUrl, '/interrupt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: task.clientId }) }); } catch (error) { logEvent(project.id, 'warn', '停止请求已发出，但 ComfyUI 未确认', { error: error.message }); } logEvent(project.id, 'warn', '用户请求停止任务', { stage: stageNames[task.stage] || task.stage, shot: task.shotId }); return json(res, 200, { ok: true, project: await getProject(project.id) }); }
    if (req.method === 'PATCH' && parts[3] === 'shots' && parts[4]) { const shot = project.plan?.shots?.find(item => Number(item.id) === Number(parts[4])); if (!shot) return json(res, 404, { error: '镜头不存在' }); const input = await body(req); for (const key of ['title', 'action', 'prompt', 'camera', 'dialogue', 'duration', 'locationId', 'characterIds']) if (input[key] !== undefined) shot[key] = key === 'duration' ? Number(input[key]) : input[key]; await saveProject(project); logEvent(project.id, 'info', '镜头信息已修改', { shot: shot.id, title: shot.title }); return json(res, 200, { ok: true, project }); }
    if (req.method === 'GET' && parts[3] === 'logs') { const tail = Math.min(Math.max(Number(url.searchParams.get('tail') || 300), 1), 1000); const text = await fs.readFile(projectLogFile(project.id), 'utf8').catch(() => ''); const lines = text.split(/\r?\n/).filter(Boolean).slice(-tail); return json(res, 200, { lines, total: lines.length }); }
    if (req.method === 'DELETE' && parts[3] === 'logs') { runtimeLogs.delete(project.id); await fs.rm(projectLogFile(project.id), { force: true }); logEvent(project.id, 'info', '日志已清空'); return json(res, 200, { ok: true }); }
    if (req.method === 'DELETE' && parts.length === 3) { await fs.rm(projectFile(project.id), { force: true }); await fs.rm(projectLogFile(project.id), { force: true }); await fs.rm(path.join(PROJECTS, safeName(project.id)), { recursive: true, force: true }); runtimeLogs.delete(project.id); return json(res, 200, { ok: true, id: project.id }); }
    if (req.method === 'POST' && parts[3] === 'stages' && parts[4]) { const stage = parts[4]; if (!ALL_STAGES.includes(stage)) return json(res, 400, { error: `未知阶段：${stage}` }); const preflightError = stagePreflight(project, stage); if (preflightError) return json(res, 400, { error: preflightError, project }); if (project.stages?.[stage]?.status === 'running') return json(res, 409, { error: `${stageNames[stage]}正在执行，请等待当前任务结束。`, project }); const input = await body(req); const jobId = id(); runningJobs.set(jobId, { projectId: project.id, stage, startedAt: new Date().toISOString() }); runStage(project, stage, input).catch(() => {}).finally(() => runningJobs.delete(jobId)); return json(res, 202, { jobId, project: await getProject(project.id) }); }
    if (req.method === 'GET' && parts[3] === 'files' && parts[4]) { const file = decodeURIComponent(parts.slice(4).join('/')); const projectDir = path.resolve(PROJECTS, safeName(project.id)); const requested = path.resolve(projectDir, file); if (!requested.startsWith(`${projectDir}${path.sep}`)) return json(res, 400, { error: '文件路径无效' }); const ext = path.extname(file).toLowerCase(); const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.srt': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8' }[ext] || 'application/octet-stream'; return serveFile(res, requested, mime); }
  }
  if (req.method === 'GET') { const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1); const ext = path.extname(file); const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' }[ext] || 'application/octet-stream'; return serveFile(res, path.join(PUBLIC, file), mime); }
  json(res, 404, { error: 'Not found' });
}

await ensure();
const appServer = http.createServer((req, res) => handle(req, res).catch(error => json(res, 500, { error: error.message })));
function startServer(port) {
  appServer.once('error', error => {
    if (error.code === 'EADDRINUSE') { console.error(`LongV 启动失败：端口 ${port} 已被占用。请先运行 停止.bat，或关闭占用该端口的软件。`); process.exitCode = 1; return; }
    throw error;
  });
  appServer.listen(port, '127.0.0.1', () => console.log(`LongV Studio running at http://127.0.0.1:${port}`));
}
startServer(PORT);
