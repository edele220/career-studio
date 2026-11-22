const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const ResumeDocument = require("./resume-model.js");

const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\.json$/;
const MAX_BYTES = 1024 * 1024;
const EXPERIENCE_TYPES = ["工作经历", "项目经历", "实习经历", "个人作品", "技能与工具", "其他补充"];
const clean = value => typeof value === "string" ? value.trim() : "";
const texts = value => Array.isArray(value) ? value.map(clean).filter(Boolean) : [];
const isRecord = value => value && typeof value === "object" && !Array.isArray(value);
const makeId = prefix => `${prefix}-${randomUUID()}`;
const fingerprint = bundle => createHash("sha256").update(JSON.stringify(bundle)).digest("hex");

function validateBundle(bundle, fileName) {
  if (!isRecord(bundle) || bundle.version !== 1 || bundle.id !== path.basename(fileName, ".json")) {
    throw new Error("记录需要 version: 1，且 id 必须等于文件名（不含 .json）。");
  }
  for (const field of ["job", "analysis", "resume"]) {
    if (bundle[field] !== undefined && !isRecord(bundle[field])) throw new Error(`${field} 格式不正确。`);
  }
  if (bundle.experiences !== undefined && (!Array.isArray(bundle.experiences) || bundle.experiences.some(item => !isRecord(item) || !clean(item.name)))) {
    throw new Error("每条经历必须包含名称。");
  }
  if (!bundle.job && !bundle.analysis && !bundle.resume && !bundle.experiences?.length) {
    throw new Error("记录中没有可收录的岗位、分析、经历或简历。");
  }
  if (bundle.job && (!clean(bundle.job.title) || !clean(bundle.job.company)) && !clean(bundle.jobId)) {
    throw new Error("新岗位需要填写真实岗位名称和公司名称。");
  }
  return bundle;
}

async function readBundle(directory, fileName) {
  if (typeof fileName !== "string" || !FILE_NAME.test(fileName)) throw new Error("无效的待收录文件名。");
  const target = path.join(directory, fileName);
  const stat = await fs.lstat(target);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("请选择 1 MB 以内的 JSON 文件。");
  const input = await fs.readFile(target, "utf8");
  if (Buffer.byteLength(input) > MAX_BYTES) throw new Error("记录文件超过 1 MB。");
  return validateBundle(JSON.parse(input.replace(/^\uFEFF/, "")), fileName);
}

async function listBundles(directory, receipts) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter(item => item.isFile() && FILE_NAME.test(item.name) &&
    !Object.hasOwn(receipts, path.basename(item.name, ".json")))
    .sort((left, right) => right.name.localeCompare(left.name)).map(async item => {
      try {
        const record = await readBundle(directory, item.name);
        return { file: item.name, record, fingerprint: fingerprint(record) };
      }
      catch (error) { return { file: item.name, error: error.message }; }
    }));
}

function selectJob(state, bundle, timestamp) {
  const id = clean(bundle.jobId);
  if (id) {
    const existing = state.jobs.find(item => item.id === id);
    if (!existing) throw new Error("找不到记录指定的岗位，请核对 jobId。");
    return existing;
  }
  if (!bundle.job) return null;
  const { job } = bundle;
  const title = clean(job.title);
  const company = clean(job.company);
  const matches = state.jobs.filter(item => clean(item.title).toLowerCase() === title.toLowerCase() &&
    clean(item.company).toLowerCase() === company.toLowerCase());
  if (matches.length > 1) throw new Error("有多条同名岗位，请在记录中指定 jobId。");
  if (matches.length === 1) return matches[0];
  const record = {
    id: makeId("j"), title, company,
    platform: ["BOSS 直聘", "猎聘", "前程无忧", "公司官网", "朋友推荐"].includes(job.platform) ? job.platform : "其他",
    url: clean(job.url), location: clean(job.location), salary: clean(job.salary),
    status: "收集", category: clean(job.category), responsibilities: clean(job.responsibilities),
    requirements: clean(job.requirements), jd: clean(job.jd), notes: clean(job.notes),
    createdAt: timestamp, updatedAt: timestamp
  };
  state.jobs.unshift(record);
  return record;
}

function addConversationExperiences(state, records, source, timestamp) {
  const importedIds = new Map();
  const added = records.map(item => {
    const experience = {
      id: makeId("e"), name: clean(item.name),
      type: EXPERIENCE_TYPES.includes(item.type) ? item.type : "其他补充",
      organization: clean(item.organization), period: clean(item.period),
      background: clean(item.background), task: clean(item.task), action: clean(item.action), result: clean(item.result),
      evidence: clean(item.evidence), tools: clean(item.tools), tags: texts(item.tags), raw: clean(item.raw),
      source, createdAt: timestamp
    };
    const ref = clean(item.ref);
    if (ref) {
      if (importedIds.has(ref) || state.experiences.some(existing => existing.id === ref)) throw new Error(`经历引用重复：${ref}`);
      importedIds.set(ref, experience.id);
    }
    return experience;
  });
  state.experiences.unshift(...added);
  return importedIds;
}

function applyBundle(inputState, bundle) {
  if (Object.hasOwn(inputState.inboxReceipts, bundle.id)) throw new Error("这条对话记录已经收录。");
  const state = structuredClone(inputState);
  const timestamp = new Date().toISOString();
  const source = clean(bundle.source) || "本地对话";
  const job = selectJob(state, bundle, timestamp);
  const importedIds = addConversationExperiences(state, bundle.experiences || [], source, timestamp);
  const resolveExperience = ref => {
    const id = importedIds.get(ref) || ref;
    const experience = state.experiences.find(item => item.id === id);
    if (!experience) throw new Error(`找不到经历引用：${ref || "（为空）"}`);
    return experience;
  };

  let analysisId = "";
  if (bundle.analysis) {
    if (!job) throw new Error("岗位分析需要关联一个岗位。");
    const input = bundle.analysis;
    if (input.evidence !== undefined && (!Array.isArray(input.evidence) || input.evidence.some(item => !isRecord(item) || !clean(item.reason)))) {
      throw new Error("每条匹配证据需有经历引用和对应理由。");
    }
    const evidence = (input.evidence || []).map(item => {
      const experience = resolveExperience(clean(item.experienceId));
      return { experienceId: experience.id, experienceName: experience.name, reason: clean(item.reason) };
    });
    const analysis = {
      id: makeId("an"), kind: "conversation", source, createdAt: timestamp,
      summary: clean(input.summary), requirements: texts(input.requirements), evidence,
      gaps: texts(input.gaps), suggestions: texts(input.suggestions), recommendation: clean(input.recommendation),
      jdSnapshot: clean(bundle.job?.jd) || clean(job.jd)
    };
    if (!analysis.summary && !analysis.requirements.length && !analysis.evidence.length &&
        !analysis.gaps.length && !analysis.suggestions.length && !analysis.recommendation) {
      throw new Error("岗位分析至少需要一项实际结论。");
    }
    const oldVersions = Object.hasOwn(state.analyses, job.id) ? state.analyses[job.id]?.versions : [];
    state.analyses[job.id] = { versions: [analysis, ...(Array.isArray(oldVersions) ? oldVersions : [])] };
    job.updatedAt = timestamp;
    analysisId = analysis.id;
  }

  let resumeId = "";
  if (bundle.resume) {
    if (!job) throw new Error("针对性简历需要关联一个岗位。");
    const references = texts(bundle.resume.experienceIds);
    if (!references.length) throw new Error("简历草稿需要至少一条真实经历引用。");
    const experiences = [...new Map(references.map(ref => {
      const experience = resolveExperience(ref);
      return [experience.id, experience];
    })).values()];
    const resume = {
      id: makeId("r"), jobId: job.id, target: job.title, name: clean(bundle.resume.name) || `${job.title} · 对话草稿`,
      expIds: experiences.map(item => item.id), doc: ResumeDocument.create(state.profile, job, experiences, clean(bundle.resume.summary)),
      source, createdAt: timestamp
    };
    state.resumes.unshift(resume);
    resumeId = resume.id;
  }

  state.inboxReceipts[bundle.id] = timestamp;
  return { state, result: { jobId: job?.id || "", experienceCount: bundle.experiences?.length || 0, analysisId, resumeId } };
}

module.exports = { listBundles, readBundle, applyBundle, fingerprint };
