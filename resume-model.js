const ResumeDocument = (() => {
  const presets = {
    clean: { label: "清晰单栏", layout: "single", accent: "#315b50", font: "sans", size: 13, margin: 38, line: 1.55, gap: 17, align: "left", heading: "line", column: 32 },
    classic: { label: "经典居中", layout: "single", accent: "#343434", font: "serif", size: 14, margin: 43, line: 1.55, gap: 18, align: "center", heading: "plain", column: 32 },
    compact: { label: "紧凑单页", layout: "single", accent: "#365374", font: "sans", size: 12, margin: 29, line: 1.42, gap: 12, align: "left", heading: "line", column: 32 },
    columns: { label: "双栏侧边", layout: "right", accent: "#365374", font: "sans", size: 13, margin: 35, line: 1.52, gap: 16, align: "left", heading: "block", column: 31 }
  };
  const fonts = {
    sans: '"Microsoft YaHei", "PingFang SC", Arial, sans-serif',
    serif: '"Songti SC", SimSun, Georgia, serif',
    modern: '"Segoe UI", "Microsoft YaHei", sans-serif',
    kai: 'KaiTi, "Kaiti SC", "Microsoft YaHei", serif'
  };
  const text = value => typeof value === "string" ? value : "";
  const choice = (value, options, fallback) => options.includes(value) ? value : fallback;
  const between = (value, min, max, fallback) => value !== undefined && value !== null && value !== "" &&
    Number.isFinite(Number(value)) ? Math.max(min, Math.min(max, Number(value))) : fallback;
  const entry = () => ({ title: "", subtitle: "", date: "", body: "", experienceId: "" });
  const section = (title = "", area = "auto", entries = [entry()]) => ({ title, area, entries, visible: true });

  function normalize(raw) {
    if (!raw || !Array.isArray(raw.sections)) throw new Error("请选择有效的简历草稿 JSON。");
    const input = raw.style || raw;
    const fallback = presets.clean;
    return {
      name: text(raw.name), role: text(raw.role), contact: text(raw.contact),
      style: {
        layout: choice(input.layout, ["single", "left", "right"], fallback.layout),
        accent: /^#[0-9a-f]{6}$/i.test(text(input.accent)) ? input.accent : fallback.accent,
        font: choice(input.font, Object.keys(fonts), fallback.font),
        size: between(input.size, 10, 20, fallback.size),
        nameSize: between(input.nameSize, 18, 48, 29),
        margin: between(input.margin ?? input.pad, 16, 66, fallback.margin),
        line: between(input.line, 1.15, 2.2, fallback.line),
        gap: between(input.gap, 8, 35, fallback.gap),
        align: choice(input.align, ["left", "center", "right"], fallback.align),
        heading: choice(input.heading, ["line", "plain", "block"], fallback.heading),
        column: between(input.column, 23, 45, fallback.column),
        paper: choice(input.paper, ["A4", "letter"], "A4")
      },
      sections: raw.sections.filter(Boolean).map(part => ({
        title: text(part.title), visible: part.visible !== false,
        area: choice(part.area, ["auto", "full", "main", "side"], "auto"),
        entries: (Array.isArray(part.entries) ? part.entries : []).filter(Boolean).map(item => ({
          title: text(item.title), subtitle: text(item.subtitle), date: text(item.date),
          body: text(item.body), experienceId: text(item.experienceId)
        }))
      }))
    };
  }

  function experienceEntry(experience) {
    const body = [experience.action || experience.task || experience.raw || experience.background, experience.result]
      .filter(Boolean).map(line => line.trim()).filter(Boolean)
      .map(line => /^\s*[-•]\s/.test(line) ? line : `- ${line}`).join("\n");
    return { ...entry(), title: experience.name, subtitle: text(experience.organization),
      date: text(experience.period), body, experienceId: experience.id };
  }

  function addExperiences(draft, experiences) {
    const included = new Set(draft.sections.flatMap(part => part.entries.map(item => item.experienceId)));
    let count = 0;
    for (const experience of experiences) {
      if (included.has(experience.id)) continue;
      const title = experience.type || "相关经历";
      let part = draft.sections.find(item => item.title === title && item.visible);
      if (!part) {
        part = section(title, "main", []);
        draft.sections.push(part);
      }
      part.entries.push(experienceEntry(experience));
      included.add(experience.id);
      count++;
    }
    return count;
  }

  function create(profile = {}, job, experiences = [], summary = "") {
    const draft = normalize({ name: profile.name === "朋友" ? "" : profile.name,
      role: job?.title || profile.target, contact: profile.contact, style: profile.resumeStyle, sections: [] });
    if (summary.trim()) draft.sections.push(section("个人概述", "full", [{ ...entry(), body: summary.trim() }]));
    addExperiences(draft, experiences);
    const tools = [...new Set(experiences.flatMap(item => text(item.tools).split(/[、,，;；\n]/).map(tool => tool.trim()).filter(Boolean)))];
    if (tools.length) draft.sections.push(section("技能与工具", "side", [{ ...entry(), body: tools.join(" · ") }]));
    return draft;
  }

  return { presets, fonts, normalize, section, entry, create, addExperiences };
})();

if (typeof module !== "undefined") module.exports = ResumeDocument;
