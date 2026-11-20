const JobFields = (() => {
  const labels = {
    title: "岗位名称|职位名称|招聘岗位|岗位|职位|Job title",
    company: "公司名称|招聘公司|用人单位|公司|Company",
    location: "工作地点|工作地址|工作城市|地点|Location",
    salary: "薪资范围|薪资待遇|薪酬范围|薪资|薪酬|Salary",
    responsibilities: "岗位职责|工作职责|职位职责|岗位描述|工作内容|职位描述|职责|Responsibilities|What you.ll do",
    requirements: "任职要求|岗位要求|职位要求|任职资格|应聘条件|资格要求|要求|Requirements|Qualifications",
    other: "福利待遇|加分项|优先条件|投递方式|招聘流程|公司介绍|Benefits|How to apply"
  };
  const markers = Object.entries(labels).map(([field, options]) => [field, new RegExp(
    `^(?:(?:[一二三四五六七八九十]+|[0-9]+)[、.．)）]\\s*)?(?:${options})(?:\\s*[:：．]\\s*(.*)|\\s*)$`, "i"
  )]);

  function normalizeOcr(text) {
    return text.replace(/([\p{Script=Han}：，。；、．！？])[ \t]+(?=[\p{Script=Han}：，。；、．！？])/gu, "$1")
      .replace(/[ \t]+(?=[：，。；、．！？])/g, "");
  }

  function fromText(text) {
    const fields = {};
    const sections = { responsibilities: [], requirements: [] };
    let current = "";
    for (const line of text.split(/\r?\n/)) {
      const clean = normalizeOcr(line).trim();
      if (!clean) continue;
      const marker = markers.find(([, pattern]) => pattern.test(clean));
      if (marker) {
        const [field, pattern] = marker;
        const value = clean.match(pattern)[1]?.trim();
        current = Object.hasOwn(sections, field) ? field : "";
        if (current && value) sections[current].push(value);
        else if (field !== "other" && value) fields[field] ||= value;
      } else if (current) {
        sections[current].push(line.trim());
      }
    }
    for (const [field, lines] of Object.entries(sections)) {
      if (lines.length) fields[field] = lines.join("\n");
    }
    return fields;
  }

  function htmlDocument(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    return template.content;
  }

  function visibleText(root) {
    const pieces = [];
    const blocks = /^(ADDRESS|ARTICLE|ASIDE|BLOCKQUOTE|BR|DD|DIV|DL|DT|H[1-6]|LI|MAIN|OL|P|SECTION|TABLE|TD|TH|TR|UL)$/;
    const hidden = /^(HEAD|IFRAME|NOSCRIPT|SCRIPT|STYLE|SVG|TEMPLATE|TITLE)$/;
    function visit(node) {
      if (node.nodeType === 3) {
        pieces.push(node.data.replace(/\s+/g, " "));
        return;
      }
      if (hidden.test(node.nodeName) || node.hasAttribute?.("hidden")) return;
      if (blocks.test(node.nodeName)) pieces.push("\n");
      for (const child of node.childNodes) visit(child);
      if (blocks.test(node.nodeName)) pieces.push("\n");
    }
    visit(root);
    return pieces.join("").split("\n").map(line => line.trim()).filter(Boolean).join("\n");
  }

  function findJobPosting(root) {
    for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try { parsed = JSON.parse(script.textContent); } catch { continue; }
      const pending = [parsed];
      while (pending.length) {
        const item = pending.pop();
        if (Array.isArray(item)) {
          for (let i = item.length - 1; i >= 0; i--) pending.push(item[i]);
        } else if (item && typeof item === "object") {
          if ([item["@type"]].flat().some(type => typeof type === "string" && /(^|\/)JobPosting$/.test(type))) return item;
          pending.push(item.mainEntity, item["@graph"]);
        }
      }
    }
  }

  function asText(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  function jobSalary(baseSalary) {
    if (typeof baseSalary === "string") return baseSalary;
    const amount = baseSalary?.value;
    const currency = baseSalary?.currency === "CNY" ? "元" : asText(baseSalary?.currency);
    const unit = { HOUR: "小时", DAY: "天", WEEK: "周", MONTH: "月", YEAR: "年" }[amount?.unitText] || "";
    const values = [amount?.minValue ?? amount?.value, amount?.maxValue].filter(value => typeof value === "number" || asText(value));
    return values.length ? `${[...new Set(values)].join("–")}${currency}${unit ? "/" + unit : ""}` : "";
  }

  function fromPage(content, isHtml) {
    const root = isHtml ? htmlDocument(content) : null;
    const posting = root && findJobPosting(root);
    if (posting) {
      const description = value => visibleText(htmlDocument(asText(value)));
      const jd = description(posting.description);
      const fields = fromText(jd);
      const rawLocation = [posting.jobLocation].flat().map(place => place?.address).map(address =>
        asText(address) || asText(address?.addressLocality) || asText(address?.addressRegion)
      ).filter(Boolean).join(" / ");
      return {
        jd: jd || [description(posting.responsibilities), description(posting.qualifications)].filter(Boolean).join("\n"),
        title: asText(posting.title) || fields.title,
        company: asText(posting.hiringOrganization?.name) || fields.company,
        location: rawLocation || (posting.jobLocationType === "TELECOMMUTE" ? "远程" : fields.location),
        salary: jobSalary(posting.baseSalary) || fields.salary,
        responsibilities: description(posting.responsibilities) || fields.responsibilities,
        requirements: description(posting.qualifications) || fields.requirements
      };
    }
    if (root) root.querySelectorAll("nav,header,footer,aside").forEach(node => node.remove());
    const jd = (root ? visibleText(root.querySelector("main,[role=main]") || root) : content).trim();
    const fields = fromText(jd);
    if (!fields.responsibilities && !fields.requirements && !(fields.title && fields.company)) return null;
    if (!fields.title && root) fields.title = root.querySelector("h1")?.textContent.trim();
    return { ...fields, jd };
  }

  function httpUrl(value) {
    try {
      const url = new URL(value);
      if (["https:", "http:"].includes(url.protocol) && !url.username && !url.password) return url;
    } catch {}
    return null;
  }

  function platformForUrl(url) {
    for (const [domain, platform] of [["zhipin.com", "BOSS 直聘"], ["liepin.com", "猎聘"], ["51job.com", "前程无忧"]]) {
      if (url.hostname === domain || url.hostname.endsWith("." + domain)) return platform;
    }
    return "公司官网";
  }

  return { fromText, fromPage, normalizeOcr, httpUrl, platformForUrl };
})();
