const ConversationUI = (() => {
  const byId = id => document.getElementById(id);
  const localInbox = location.protocol === "http:" && ["127.0.0.1", "localhost"].includes(location.hostname);
  let accepting = false;
  let refreshRequest;

  function node(tag, text = "", className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function button(label, action, primary = false) {
    const result = node("button", label, `btn small${primary ? " primary" : ""}`);
    result.type = "button";
    result.onclick = action;
    return result;
  }

  function list(parent, title, values) {
    if (!Array.isArray(values) || !values.length) return;
    const items = node("ul");
    for (const value of values) items.append(node("li", typeof value === "string" ? value : value?.reason || ""));
    parent.append(node("h4", title), items);
  }

  function text(parent, title, value) {
    if (!value) return;
    parent.append(node("h4", title), node("p", value, "record-text"));
  }

  function reportBody(parent, report, showLinks) {
    text(parent, "结论", report.summary);
    list(parent, "岗位要求", report.requirements);
    if (Array.isArray(report.evidence) && report.evidence.length) {
      const evidence = node("ul");
      for (const item of report.evidence) {
        if (!item || typeof item !== "object") continue;
        const row = node("li", item.reason || "");
        const experience = showLinks && getExp(item.experienceId);
        if (experience) {
          const link = node("button", experience.name, "link");
          link.type = "button";
          link.onclick = () => { closeModal("jobDetailModal"); openExperienceModal(experience.id); };
          row.prepend(link, document.createTextNode("　"));
        } else if (item.experienceName || item.experienceId) row.prepend(document.createTextNode(`${item.experienceName || item.experienceId}　`));
        evidence.append(row);
      }
      parent.append(node("h4", "匹配证据"), evidence);
    }
    list(parent, "缺口或待确认", report.gaps);
    text(parent, "投递建议", report.recommendation);
    list(parent, "简历调整建议", report.suggestions);
  }

  function renderJob(id) {
    const host = byId("jobConversationRecords");
    const reports = (state.analyses[id]?.versions || []).filter(item => item.kind === "conversation");
    host.replaceChildren(node("h3", "分析记录"));
    if (!reports.length) host.append(node("p", "把对话里的 JD 分析收录后，会显示在这里。", "hint"));
    reports.forEach((report, index) => {
      const block = node("details", "", "record-report");
      block.open = index === 0;
      block.append(node("summary", `${report.source || "本地对话"} · ${formatDate(report.createdAt, true)}`));
      reportBody(block, report, true);
      if (report.jdSnapshot) {
        const jd = node("details", "", "record-report");
        jd.append(node("summary", "分析时的 JD"), node("p", report.jdSnapshot, "record-text"));
        block.append(jd);
      }
      if (report.evidence?.some(item => getExp(item.experienceId))) {
        block.append(button("按这版分析组装简历", () => ResumeDesigner.fromJob(id, report.id)));
      }
      host.append(block);
    });
    const versions = state.resumes.filter(item => item.jobId === id);
    if (versions.length) {
      host.append(node("h3", "关联简历"));
      const actions = node("div", "", "rd-toolbar");
      for (const version of versions) actions.append(button(version.name || version.target || "简历草稿", () => ResumeDesigner.openVersion(version.id)));
      host.append(actions);
    }
  }

  async function request(url, options) {
    if (!localInbox) throw new Error("请从本机工作台打开对话收件箱。");
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || "读取对话记录失败。");
    return data;
  }

  function preview(item) {
    const record = item.record;
    const body = byId("conversationInboxBody");
    body.replaceChildren();
    body.append(node("h3", record.title || record.job?.title || "对话记录"), node("p", record.source || "本地对话", "hint"));
    if (record.job || record.jobId) {
      const job = record.job || getJob(record.jobId);
      text(body, "关联岗位", job ? `${job.title || ""} · ${job.company || ""}` : `岗位 ID ${record.jobId}`);
      if (record.job?.jd) {
        const block = node("details", "", "record-report");
        block.append(node("summary", "查看 JD 原文"), node("p", record.job.jd, "record-text"));
        body.append(block);
      }
    }
    if (record.analysis) {
      const block = node("div", "", "record-report");
      reportBody(block, record.analysis, false);
      body.append(block);
    }
    for (const experience of record.experiences || []) {
      const block = node("details", "", "record-report");
      block.open = true;
      block.append(node("summary", `${experience.name} · ${experience.type || "经历素材"}`));
      for (const [label, key] of [["组织", "organization"], ["时间", "period"], ["背景", "background"], ["任务", "task"], ["行动", "action"], ["结果", "result"], ["工具", "tools"], ["证明材料", "evidence"], ["原始记录", "raw"]]) {
        text(block, label, experience[key]);
      }
      body.append(block);
    }
    if (record.resume) {
      const block = node("div", "", "record-report");
      text(block, "简历草稿", record.resume.name || "针对性简历");
      const refs = Array.isArray(record.resume.experienceIds) ? record.resume.experienceIds : [];
      list(block, "将使用的经历", refs.map(ref => getExp(ref)?.name || record.experiences?.find(exp => exp.ref === ref)?.name || ref));
      text(block, "个人概述", record.resume.summary);
      body.append(block);
    }
    const foot = byId("conversationInboxFoot");
    foot.replaceChildren(button("返回列表", open), button("确认收录", () => accept(item), true));
  }

  async function accept({ file, fingerprint }) {
    if (accepting) return;
    accepting = true;
    const foot = byId("conversationInboxFoot");
    const actions = [...foot.querySelectorAll("button")];
    for (const action of actions) action.disabled = true;
    const status = node("span", "正在写入数据库…", "hint");
    foot.prepend(status);
    try {
      await databaseSaveChain;
      const { state: latest, result, revision } = await request("/api/inbox/accept", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ file, fingerprint })
      });
      applyDatabaseState(latest, revision);
      byId("conversationInboxBody").replaceChildren(node("p", "已收录到工作台。"));
      foot.replaceChildren(button("继续查看收件箱", open));
      if (result.experienceCount) foot.append(button(`查看经历库（新增 ${result.experienceCount} 条）`, () => { closeModal("conversationInbox"); go("experience"); }));
      if (result.jobId) foot.append(button("查看岗位", () => { closeModal("conversationInbox"); showJobDetail(result.jobId); }));
      if (result.resumeId) foot.append(button("打开简历草稿", () => { closeModal("conversationInbox"); ResumeDesigner.openVersion(result.resumeId); }, true));
      refresh();
    } catch (error) {
      status.textContent = error.message;
      for (const action of actions) action.disabled = false;
    } finally { accepting = false; }
  }

  function refresh() {
    if (refreshRequest) return refreshRequest;
    refreshRequest = request("/api/inbox").then(({ items }) => {
      const count = items.length;
      document.querySelectorAll(".inbox-count").forEach(badge => { badge.hidden = !count; badge.textContent = count; });
      return items;
    }).finally(() => { refreshRequest = null; });
    refreshRequest.catch(() => {});
    return refreshRequest;
  }

  async function open() {
    if (accepting) return;
    openModal("conversationInbox");
    const body = byId("conversationInboxBody");
    body.replaceChildren(node("p", "正在查询待收录记录…", "hint"));
    byId("conversationInboxFoot").replaceChildren(button("刷新", open));
    try {
      const items = await refresh();
      body.replaceChildren();
      if (!items.length) {
        body.append(node("p", "暂无待收录内容。把 JD 或经历发给 Codex 后，可以让它存入工作台收件箱。"));
        return;
      }
      const rows = node("div", "", "record-list");
      for (const item of items) {
        const card = node("div", "", "record-card");
        const record = item.record;
        card.append(node("b", record?.title || record?.job?.title || item.file));
        if (item.error) card.append(node("p", item.error, "hint"));
        else {
          const types = [record.job || record.jobId ? "岗位" : "", record.analysis ? "分析" : "",
            record.experiences?.length ? `${record.experiences.length} 条经历` : "", record.resume ? "简历草稿" : ""].filter(Boolean);
          card.append(node("p", types.join(" · "), "hint"), button("预览", () => preview(item)));
        }
        rows.append(card);
      }
      body.append(rows);
    } catch (error) { body.replaceChildren(node("p", error.message, "hint")); }
  }

  return { open, refresh, renderJob, isAccepting: () => accepting };
})();
