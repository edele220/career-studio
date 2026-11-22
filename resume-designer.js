const ResumeDesigner = (() => {
  const byId = id => document.getElementById(id);
  const completeDate = new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" });
  let draft;
  let jobId = "";
  let versionId = "";
  let versionName = "";
  let dirty = false;
  let saving = false;
  let savingStyle = false;
  let hydrated = false;
  let pending = new Set();
  const expanded = new WeakSet();

  function node(tag, text = "", className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(parent, title, action, disabled = false) {
    const control = node("button", title, "btn small");
    control.type = "button";
    control.disabled = disabled;
    control.addEventListener("click", action);
    parent.append(control);
  }

  function field(parent, title, object, property, options = {}) {
    const label = node("label", title);
    const control = node(options.choices ? "select" : options.multiline ? "textarea" : "input");
    if (options.choices) {
      for (const [value, name] of options.choices) control.add(new Option(name, value));
    } else if (!options.multiline) {
      control.type = options.type || "text";
      for (const attribute of ["min", "max", "step"]) if (options[attribute] !== undefined) control[attribute] = options[attribute];
    }
    if (options.placeholder) control.placeholder = options.placeholder;
    control.value = object[property];
    control.addEventListener("input", () => {
      if (control.type === "number" && (control.value === "" || !control.validity.valid)) return;
      object[property] = control.type === "number" ? control.valueAsNumber : control.value;
      options.onInput?.(control.value);
      changed();
    });
    label.append(control);
    parent.append(label);
    return control;
  }

  function changed(rebuild = false) {
    dirty = true;
    if (rebuild) renderControls();
    renderStatus();
    renderPreview();
  }

  function renderStatus() {
    byId("resumeStatus").textContent = saving ? "正在保存…" : dirty ? "有未保存的修改" : versionId ? "正在查看已保存版本" : "新草稿";
    byId("resumeSave").disabled = saving || !databaseReady;
    byId("resumeSaveStyle").disabled = savingStyle || !databaseReady;
  }

  function move(controls, list, index, label) {
    const shift = offset => {
      const [item] = list.splice(index, 1);
      list.splice(index + offset, 0, item);
      changed(true);
    };
    button(controls, `上移${label}`, () => shift(-1), index === 0);
    button(controls, `下移${label}`, () => shift(1), index === list.length - 1);
  }

  function renderControls() {
    const profile = byId("resumeIdentity");
    const style = byId("resumeStyle");
    const sections = byId("resumeSections");
    profile.replaceChildren();
    style.replaceChildren();
    sections.replaceChildren();

    field(profile, "姓名", draft, "name");
    field(profile, "求职方向", draft, "role");
    field(profile, "联系方式或个人链接", draft, "contact", { multiline: true, placeholder: "手机 · 邮箱 · 城市" });
    const options = draft.style;
    field(style, "排版", options, "layout", { choices: [["single", "单栏"], ["left", "左侧栏"], ["right", "右侧栏"]] });
    field(style, "纸张", options, "paper", { choices: [["A4", "A4"], ["letter", "Letter"]] });
    field(style, "字体", options, "font", { choices: [["sans", "无衬线"], ["serif", "宋体 / 衬线"], ["modern", "现代无衬线"], ["kai", "楷体"]] });
    field(style, "主题色", options, "accent", { type: "color" });
    field(style, "正文字号 (px)", options, "size", { type: "number", min: 10, max: 20, step: 0.5 });
    field(style, "姓名字号 (px)", options, "nameSize", { type: "number", min: 18, max: 48 });
    field(style, "页面边距 (px)", options, "margin", { type: "number", min: 16, max: 66 });
    field(style, "正文行距", options, "line", { type: "number", min: 1.15, max: 2.2, step: "any" });
    field(style, "栏目间距 (px)", options, "gap", { type: "number", min: 8, max: 35 });
    field(style, "侧栏宽度 (%)", options, "column", { type: "number", min: 23, max: 45 });
    field(style, "页首对齐", options, "align", { choices: [["left", "左对齐"], ["center", "居中"], ["right", "右对齐"]] });
    field(style, "栏目标题", options, "heading", { choices: [["line", "下划线"], ["plain", "纯文字"], ["block", "浅色底纹"]] });

    draft.sections.forEach((part, index) => {
      const panel = node("details", "", "rd-section-edit");
      const title = () => `${part.title || "未命名栏目"}${part.visible ? "" : " · 已隐藏"}`;
      const summary = node("summary", title());
      panel.open = expanded.has(part);
      panel.addEventListener("toggle", () => panel.open ? expanded.add(part) : expanded.delete(part));
      const row = node("div", "", "rd-fields pair");
      field(row, "栏目名称", part, "title", { onInput: () => { summary.textContent = title(); } });
      field(row, "双栏位置", part, "area", { choices: [["auto", "自动"], ["full", "通栏"], ["main", "主栏"], ["side", "侧栏"]] });
      const actions = node("div", "", "rd-actions rd-group");
      move(actions, draft.sections, index, "栏目");
      button(actions, part.visible ? "隐藏" : "显示", () => { part.visible = !part.visible; changed(true); });
      button(actions, "删除栏目", () => {
        if (confirm("删除当前草稿中的这个栏目？")) { draft.sections.splice(index, 1); changed(true); }
      });
      panel.append(summary, row, actions);
      part.entries.forEach((entry, entryIndex) => {
        const item = node("div", "", "rd-entry-edit");
        const entryActions = node("div", "", "rd-actions");
        if (entry.experienceId) entryActions.append(node("span", "来自经历库", "hint"));
        move(entryActions, part.entries, entryIndex, "条目");
        button(entryActions, "删除条目", () => {
          if (confirm("删除当前草稿中的这条内容？")) { part.entries.splice(entryIndex, 1); changed(true); }
        });
        const identity = node("div", "", "rd-fields pair");
        field(identity, "标题", entry, "title");
        field(identity, "副标题", entry, "subtitle");
        const content = node("div", "", "rd-fields");
        field(content, "日期", entry, "date");
        field(content, "正文", entry, "body", { multiline: true, placeholder: "直接输入段落，每行以 - 加空格开头可生成项目符号" });
        item.append(entryActions, identity, content);
        panel.append(item);
      });
      const add = node("div", "", "rd-actions rd-group");
      button(add, "添加条目", () => { part.entries.push(ResumeDocument.entry()); changed(true); });
      panel.append(add);
      sections.append(panel);
    });
  }

  function appendBody(parent, body) {
    let list;
    for (const line of body.trim().split(/\r?\n/)) {
      const bullet = /^\s*[-•]\s+(.+)$/.exec(line);
      if (bullet) {
        if (!list) { list = node("ul"); parent.append(list); }
        list.append(node("li", bullet[1]));
      } else {
        list = null;
        if (line.trim()) parent.append(node("p", line));
      }
    }
  }

  function documentElement(raw) {
    const data = ResumeDocument.normalize(raw);
    const style = data.style;
    const paper = node("article", "", "rd-paper");
    paper.setAttribute("aria-label", "简历");
    paper.dataset.layout = style.layout;
    paper.dataset.heading = style.heading;
    const values = { accent: style.accent, font: ResumeDocument.fonts[style.font], size: `${style.size}px`,
      "name-size": `${style.nameSize}px`, pad: `${style.margin}px`, line: style.line, gap: `${style.gap}px`,
      align: style.align, column: `${style.column}%`, width: style.paper === "A4" ? "210mm" : "8.5in",
      height: style.paper === "A4" ? "297mm" : "11in" };
    for (const [name, value] of Object.entries(values)) paper.style.setProperty(`--rd-${name}`, value);
    const header = node("header");
    if (data.name.trim()) header.append(node("h1", data.name));
    if (data.role.trim()) header.append(node("div", data.role, "rd-role"));
    if (data.contact.trim()) header.append(node("div", data.contact, "rd-contact"));
    if (header.childElementCount) paper.append(header);

    let main, side;
    for (const part of data.sections) {
      if (!part.visible) continue;
      const entries = part.entries.filter(item => [item.title, item.subtitle, item.date, item.body].some(value => value.trim()));
      if (!entries.length) continue;
      const block = node("section");
      if (part.title.trim()) block.append(node("h2", part.title));
      for (const entry of entries) {
        const item = node("div", "", "rd-entry");
        if (entry.title.trim() || entry.date.trim()) {
          const line = node("div", "", "rd-entry-head");
          line.append(node("strong", entry.title), node("span", entry.date, "rd-sub"));
          item.append(line);
        }
        if (entry.subtitle.trim()) item.append(node("div", entry.subtitle, "rd-sub"));
        appendBody(item, entry.body);
        block.append(item);
      }
      if (style.layout === "single" || part.area === "full") {
        main = side = null;
        paper.append(block);
      } else {
        if (!main) {
          const row = node("div", "", "rd-columns");
          main = node("div", "", "rd-main");
          side = node("div", "", "rd-side");
          side.hidden = true;
          row.append(main, side);
          paper.append(row);
        }
        const area = part.area === "side" || (part.area === "auto" && /技能|证书|语言|联系方式/.test(part.title)) ? side : main;
        area.append(block);
        if (area === side) side.hidden = false;
      }
    }
    return paper;
  }

  function renderPreview() {
    if (!draft) return;
    const paper = documentElement(draft);
    byId("resumeStage").replaceChildren(paper);
    const empty = !paper.textContent.trim();
    byId("resumeEmpty").hidden = !empty;
    paper.hidden = empty;
    byId("resumeExport").disabled = empty;
    byId("resumePrint").disabled = empty;
    fitPreview();
  }

  function fitPreview() {
    const stage = byId("resumeStage");
    const paper = stage.firstElementChild;
    if (!paper || paper.hidden || !stage.clientWidth) return;
    const scale = Math.min(1, stage.clientWidth / paper.offsetWidth);
    paper.style.transform = `scale(${scale})`;
    paper.style.left = `${Math.max(0, (stage.clientWidth - paper.offsetWidth * scale) / 2)}px`;
    stage.style.height = `${Math.ceil(paper.offsetHeight * scale)}px`;
  }

  function renderLibrary() {
    const select = byId("resumeJob");
    select.replaceChildren(new Option("通用简历 · 无关联岗位", ""));
    for (const job of state.jobs) select.add(new Option(`${job.title} · ${job.company}`, job.id));
    select.value = getJob(jobId) ? jobId : "";
    const picker = byId("resumeMaterials");
    picker.replaceChildren();
    const included = new Set(draft.sections.flatMap(part => part.entries.map(entry => entry.experienceId)));
    for (const item of state.experiences) {
      const label = node("label", "", "rd-experience");
      const input = node("input");
      input.type = "checkbox";
      input.disabled = included.has(item.id);
      input.checked = input.disabled || pending.has(item.id);
      input.addEventListener("change", () => input.checked ? pending.add(item.id) : pending.delete(item.id));
      label.append(input, node("span", `${item.name} · ${included.has(item.id) ? "已加入" : item.type}`));
      picker.append(label);
    }
    if (!state.experiences.length) picker.append(node("p", "经历库为空。可以先手动编辑简历，或收录一条经历。", "hint"));
    byId("resumeAddMaterials").disabled = !state.experiences.length;
    const versions = byId("resumeVersions");
    versions.replaceChildren();
    for (const version of state.resumes) {
      const date = new Date(version.createdAt);
      const label = version.name || version.target || "简历草稿";
      button(versions, `${label}${Number.isNaN(date.valueOf()) ? "" : ` · ${completeDate.format(date)}`}`, () => openVersion(version.id));
      if (version.id === versionId) versions.lastChild.classList.add("soft");
    }
    if (!state.resumes.length) versions.append(node("p", "保存后的版本会在这里显示。", "hint"));
  }

  function render() {
    if (!draft) return;
    renderLibrary();
    renderStatus();
    renderPreview();
  }

  function setDraft(data, target = "", id = "", name = "", edited = false) {
    draft = ResumeDocument.normalize(data);
    jobId = target;
    versionId = id;
    versionName = name;
    pending = new Set();
    dirty = edited;
    byId("resumeVersionName").value = versionName;
    renderControls();
    render();
  }

  function mayReplace() {
    return !saving && (!dirty || confirm("当前草稿还有修改。继续会替换编辑区，已保存版本会保留。"));
  }

  function openVersion(id) {
    const version = state.resumes.find(item => item.id === id);
    if (!version || !mayReplace()) return;
    loadVersion(version);
    closeModal("jobDetailModal");
    go("resume");
  }

  function loadVersion(version) {
    const data = version.doc || ResumeDocument.create(state.profile, getJob(version.jobId) || { title: version.target },
      (version.expIds || []).map(getExp).filter(Boolean));
    setDraft(data, version.jobId || "", version.id, version.name || version.target);
  }

  function fromJob(id, analysisId = "") {
    const job = getJob(id);
    if (!job || !mayReplace()) return;
    const analysis = (state.analyses[id]?.versions || []).find(item => item.kind === "conversation" && (!analysisId || item.id === analysisId));
    const experiences = [...new Set((analysis?.evidence || []).map(item => item.experienceId))].map(getExp).filter(Boolean);
    setDraft(ResumeDocument.create(state.profile, job, experiences), id, "", `${job.title} · 简历`, true);
    closeModal("jobDetailModal");
    go("resume");
    if (experiences.length) toast(`已按分析加入 ${experiences.length} 条经历，可继续编辑。`);
  }

  async function save() {
    if (saving || !databaseReady) return;
    if (!documentElement(draft).textContent.trim()) { toast("请先填写简历内容。"); return; }
    const doc = ResumeDocument.normalize(draft);
    const job = getJob(jobId);
    const record = { id: uid("r"), jobId: job?.id || "", target: job?.title || doc.role,
      name: versionName.trim() || (doc.role ? `${doc.role} · 简历` : "通用简历"),
      expIds: [...new Set(doc.sections.flatMap(part => part.entries.map(entry => entry.experienceId)).filter(Boolean))],
      doc, createdAt: nowIso() };
    const snapshot = JSON.stringify(draft);
    const nameAtSave = versionName;
    const targetAtSave = jobId;
    saving = true;
    renderStatus();
    state.resumes.unshift(record);
    const saved = await persist();
    saving = false;
    if (saved) {
      versionId = record.id;
      dirty = snapshot !== JSON.stringify(draft) || nameAtSave !== versionName || targetAtSave !== jobId;
      toast("简历版本已保存。");
    } else {
      state.resumes = state.resumes.filter(item => item.id !== record.id);
      toast("草稿还在编辑区。重新读取数据库后可以再保存。");
    }
    renderLibrary();
    renderStatus();
  }

  async function saveDefaultStyle() {
    if (!databaseReady || savingStyle) return;
    const prior = state.profile.resumeStyle;
    const style = ResumeDocument.normalize(draft).style;
    state.profile.resumeStyle = style;
    savingStyle = true;
    renderStatus();
    const saved = await persist();
    savingStyle = false;
    if (saved) toast("已设为新建简历和对话草稿的默认版式。");
    else if (state.profile.resumeStyle === style) {
      if (prior) state.profile.resumeStyle = prior;
      else delete state.profile.resumeStyle;
    }
    renderStatus();
  }

  function pageRule() {
    const style = ResumeDocument.normalize(draft).style;
    return `@page{size:${style.paper};margin:${(style.margin / 3.77952756).toFixed(1)}mm}`;
  }

  function fileName() {
    return [draft.name.trim() || "个人", draft.role.trim(), "简历"].filter(Boolean).join("-").replace(/[<>:"/\\|?*]/g, "-");
  }

  async function exportHtml() {
    const paper = documentElement(draft);
    const title = fileName();
    const rule = pageRule();
    try {
      const response = await fetch("./resume-paper.css");
      if (!response.ok) throw new Error();
      const css = await response.text();
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{margin:0;background:#eee}@media print{body{background:#fff}} ${css}\n${rule}</style></head><body>${paper.outerHTML}</body></html>`;
      downloadBlob(html, `${title}.html`, "text/html;charset=utf-8");
    } catch { toast("版式文件无法读取。请从本机工作台打开后再导出。"); }
  }

  function print() {
    const style = node("style", pageRule());
    document.head.append(style);
    const title = document.title;
    document.title = fileName();
    document.body.classList.add("print-resume");
    try { window.print(); }
    finally {
      document.body.classList.remove("print-resume");
      document.title = title;
      style.remove();
    }
  }

  function init() {
    setDraft(ResumeDocument.create());
    byId("resumeNew").onclick = () => { if (mayReplace()) setDraft(ResumeDocument.create(state.profile, getJob(jobId)), jobId); };
    byId("resumeSave").onclick = save;
    byId("resumeSaveStyle").onclick = saveDefaultStyle;
    byId("resumeExport").onclick = exportHtml;
    byId("resumePrint").onclick = print;
    byId("resumeJob").onchange = event => {
      jobId = event.target.value;
      const job = getJob(jobId);
      if (job && !draft.role.trim()) { draft.role = job.title; renderControls(); }
      changed();
    };
    byId("resumeVersionName").oninput = event => { versionName = event.target.value; changed(); };
    const preset = byId("resumePreset");
    for (const [key, value] of Object.entries(ResumeDocument.presets)) preset.add(new Option(value.label, key));
    preset.onchange = () => {
      const options = ResumeDocument.presets[preset.value];
      if (options) {
        for (const key of Object.keys(draft.style)) if (Object.hasOwn(options, key)) draft.style[key] = options[key];
        changed(true);
      }
      preset.value = "";
    };
    byId("resumeAddSection").onclick = () => {
      const part = ResumeDocument.section();
      expanded.add(part);
      draft.sections.push(part);
      changed(true);
      byId("resumeSections").lastElementChild.querySelector("input").focus();
    };
    byId("resumeAddMaterials").onclick = () => {
      const added = ResumeDocument.addExperiences(draft, [...pending].map(getExp).filter(Boolean));
      if (!added) { toast("请先勾选要加入的经历。"); return; }
      pending.clear();
      changed(true);
      renderLibrary();
      toast(`已加入 ${added} 条经历。`);
    };
    byId("resumeImportDraft").onclick = () => byId("resumeDraftFile").click();
    byId("resumeDraftFile").onchange = async event => {
      const file = event.target.files[0];
      event.target.value = "";
      if (!file || !mayReplace()) return;
      try { setDraft(ResumeDocument.normalize(JSON.parse(await file.text())), jobId, "", "", true); }
      catch { toast("请选择旧简历生成器导出的草稿 JSON。"); }
    };
    window.addEventListener("beforeunload", event => { if (dirty) event.preventDefault(); });
    new ResizeObserver(fitPreview).observe(byId("resumeStage"));
  }

  function hydrate() {
    if (!hydrated && !dirty && !versionId) {
      hydrated = true;
      if (state.resumes.length) loadVersion(state.resumes[0]);
      else setDraft(ResumeDocument.create(state.profile));
    } else render();
  }

  return { init, render, hydrate, openVersion, fromJob };
})();
