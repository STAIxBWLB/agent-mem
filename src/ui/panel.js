// amem console panels (acon api 1). Runs under the shell's strict CSP and renders data as text through host.ui only.
export default (host) => {
  const { ui } = host;
  const { h } = ui;
  const root = h("div", { class: "amem" });
  host.mount.append(root);
  let panel = "review", params = {}, project = null;
  const go = (p, extra = {}) => host.navigate(host.tool, p, { ...(project ? { project } : {}), ...extra });
  const btn = (text, onclick, cls = "btn") => h("button", { type: "button", class: cls, text, onclick });
  const day = (iso) => (typeof iso === "string" ? iso.slice(0, 16).replace("T", " ") : "");
  const line = (text, max = 120) => { const flat = String(text ?? "").replace(/\s+/g, " ").trim(); return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat; };
  const act = (input) => host.action({ ...input, ...(project ? { project } : {}) });

  const picker = (s) => {
    const list = s.projects ?? [];
    if (list.length < 2) return list.length ? h("p", { class: "amem-sub", text: `Project ${list[0]}` }) : null;
    const select = h("select", { name: "project", class: "amem-input", "aria-label": "Project", onchange: () => { project = select.value; go(panel); } },
      list.map((key) => { const o = h("option", { value: key, text: key }); if (key === s.project) o.selected = true; return o; }));
    return h("label", { class: "amem-bar" }, h("span", { text: "Project" }), select);
  };

  const reviewDetail = (r) => {
    const reason = h("input", { type: "text", name: "reason", class: "amem-input", placeholder: "Reason (optional)", "aria-label": "Reject reason (optional)" });
    const actions = [
      r.acceptable ? btn("Accept", () => act({ action: "accept", id: r.id }), "btn primary") : null,
      h("form", { class: "amem-inline", onsubmit: (e) => { e.preventDefault(); act({ action: "reject", id: r.id, ...(reason.value.trim() ? { reason: reason.value.trim() } : {}) }); } },
        reason, h("button", { type: "submit", class: "btn", text: "Reject" })),
    ].filter(Boolean);
    const sections = [];
    if (r.diff) sections.push({ title: "Now and proposed", open: true, body: h("div", { class: "amem-diff" },
      h("strong", { text: "Now" }), h("pre", { class: "amem-pre", text: r.diff.now ?? "(the current note is not visible)" }),
      h("strong", { text: "Proposed" }), h("pre", { class: "amem-pre", text: r.diff.proposed }),
      h("p", { class: "amem-sub", text: `Reason: ${r.diff.reason}` })) });
    const evidence = [...(r.evidence ?? []).map((ref) => ({ title: ref, sub: "evidence reference" })),
      ...(r.targets ?? []).map((t) => ({ title: t.text ? line(t.title ?? t.text) : `mem:${t.id} (not visible)`, sub: t.at ? `mem:${t.id.slice(0, 8)} · ${t.kind} · ${day(t.at)}` : "" }))];
    sections.push({ title: `Evidence (${evidence.length})`, open: evidence.length > 0, body: ui.rows(evidence, (e) => ui.row(e)) ?? ui.empty("No evidence attached", "This kind of candidate carries no references.") });
    sections.push({ title: `Similar memories (${r.overlaps.length})`, open: r.overlaps.length > 0,
      body: ui.rows(r.overlaps, (o) => ui.row({ title: o.title ?? "Untitled note", sub: `mem:${o.id.slice(0, 8)} · overlap ${o.score.toFixed(2)}` })) ?? ui.empty("No similar memories") });
    if (r.edit !== null) {
      const text = h("textarea", { name: "edit", class: "amem-input amem-text", "aria-label": "Edited text" });
      text.value = r.edit;
      sections.push({ title: "Edit, then accept", body: h("form", { class: "amem-form", onsubmit: (e) => { e.preventDefault(); act({ action: "edit_accept", id: r.id, text: text.value }); } },
        text, h("button", { type: "submit", class: "btn", text: "Save edit and accept" })) });
    }
    return ui.detail({ kind: `${r.kind} candidate`, title: line(r.text, 90), state: { text: "pending", tone: "warn" }, whoseMove: "you", actions, summary: r.text,
      provenance: [{ label: "Proposed", value: day(r.createdAt), at: r.createdAt }, { label: "Project", value: project ?? "" }, ...(r.noteKind ? [{ label: "Note kind", value: r.noteKind }] : [])],
      sections, footer: [r.id] });
  };

  const views = {
    review(s) {
      const rows = s.rows ?? [], picked = rows.find((r) => r.id === s.selected);
      const hidden = s.hidden ? ui.notice(`${s.hidden} candidate${s.hidden === 1 ? " is" : "s are"} withheld by the privacy screen; review ${s.hidden === 1 ? "it" : "them"} with amem review walk.`, "warn") : null;
      if (picked) return [btn("Back to the queue", () => go("review")), reviewDetail(picked)];
      return [hidden, ui.rows(rows, (r) => ui.row({ title: line(r.text), sub: `${r.kind} · ${day(r.createdAt)}${r.overlaps.length ? ` · ${r.overlaps.length} similar` : ""}`,
        onOpen: () => go("review", { id: r.id }),
        verbs: [r.acceptable ? btn("Accept", () => act({ action: "accept", id: r.id }), "btn primary") : null, btn("Reject", () => act({ action: "reject", id: r.id }))].filter(Boolean) }))
        ?? ui.empty("No candidates waiting", "Agents propose memories with amem_remember; they wait here for your decision.")];
    },
    find(s) {
      const q = h("input", { type: "search", name: "q", class: "amem-input", value: s.q ?? "", placeholder: "Search memory", "aria-label": "Search memory" });
      q.value = s.q ?? "";
      const form = h("form", { class: "amem-bar", role: "search", onsubmit: (e) => { e.preventDefault(); go("find", q.value.trim() ? { q: q.value.trim() } : {}); } }, q, h("button", { type: "submit", class: "btn", text: "Search" }));
      const hits = s.hits ?? [];
      return [form, s.q ? ui.rows(hits, (x) => {
        const v = x.view, c = x.capture;
        return ui.row({ title: line(v ? v.title ?? v.text : c?.excerpt), sub: [x.source, v?.kind ?? c?.event, day(v?.at ?? c?.at), v?.stale ? "stale" : ""].filter(Boolean).join(" · ") });
      }) ?? ui.empty("Nothing found", "Search uses the same screened index as amem_search.") : ui.empty("Search this project's memory", "Results are screened exactly like amem_search.")];
    },
    timeline(s) {
      return [ui.rows(s.entries ?? [], (x) => {
        const c = x.capture;
        return c ? ui.row({ title: line(c.excerpt), sub: `capture · ${c.event} · ${day(c.at)}` }) : ui.row({ title: line(x.title ?? x.text), sub: `${x.kind} · ${x.tier} · ${x.peer} · ${day(x.at)}` });
      }) ?? ui.empty("Nothing on the timeline yet")];
    },
    work(s) {
      const lists = s.lists ?? [];
      return lists.length ? lists.map((l) => h("section", { class: "card amem-card" }, h("h3", { text: l.list }),
        h("p", { class: "amem-sub", text: Object.entries(l.fields ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ") }),
        ui.rows(l.items ?? [], (i) => ui.row({ title: i.task, sub: Object.entries(i.fields ?? {}).map(([k, v]) => `${k}: ${v}`).join(" · ") })) ?? ui.empty("No open items")))
        : [ui.empty("No open work lists", "Agents write them with amem_work_state_write.")];
    },
    goals(s) {
      return [ui.rows(s.goals ?? [], (g) => ui.row({ title: g.title, sub: [g.milestones.length ? `${g.milestones.length} milestones` : "", g.links.length ? `${g.links.length} linked tasks` : "", day(g.at)].filter(Boolean).join(" · "),
        chip: { text: g.state, tone: g.state === "done" ? "ok" : g.state === "blocked" ? "err" : "neutral" } })) ?? ui.empty("No goals", "Create one with amem goal add.")];
    },
    capacity(s) {
      if (s.withheld) return [ui.notice("The capacity report is withheld by the privacy screen.", "warn")];
      const r = s.report;
      const out = [];
      if (r) {
        out.push(h("section", { class: "card amem-card" }, h("h3", { text: "Capture" }),
          h("dl", { class: "ui-provenance" },
            h("dt", { text: "Rows" }), h("dd", { text: `${r.capture.rows} in ${r.capture.shards} shards, ${(r.capture.bytes / 1048576).toFixed(1)} MB` }),
            h("dt", { text: "Growth" }), h("dd", { text: `${Math.round(r.capture.rowsPerDay)} rows/day` }),
            h("dt", { text: "Disk free" }), h("dd", { text: `${(r.disk.freeBytes / 1073741824).toFixed(1)} GB` }),
            h("dt", { text: "Current" }), h("dd", { text: `${r.current.capMb} MB, ${r.current.retentionDays} days` }),
            h("dt", { text: "Proposed" }), h("dd", { text: `${r.proposal.capMb} MB, ${r.proposal.retentionDays} days` })),
          h("p", { class: "amem-sub", text: r.proposal.reason }),
          s.applyNeeded ? btn("Apply proposal...", () => host.action({ action: "capacity_apply" }), "btn primary") : ui.chip("current settings match the proposal", "ok")));
      } else out.push(ui.empty("No memory home yet"));
      const cutoff = () => new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z");
      out.push(h("section", { class: "card amem-card" }, h("h3", { text: "Maintenance" }),
        h("p", { class: "amem-sub", text: "Each action shows what it will change and runs only after you confirm." }),
        h("div", { class: "amem-bar" },
          btn("Evict expired capture...", () => host.action({ action: "gc" })),
          project ? btn("Demote old notes...", () => act({ action: "decay_apply" })) : null,
          project ? btn("Prune expired notes...", () => act({ action: "prune", cutoff: cutoff() })) : null,
          project ? btn("Forget this project...", () => act({ action: "project_forget" }), "btn danger") : null)));
      return out;
    },
  };

  host.onSnapshot((s) => {
    project = s.project ?? null;
    // A poll re-renders the view: carry typed values and focus over by field name.
    const values = new Map([...root.querySelectorAll("input[name], textarea[name]")].map((el) => [el.name, el.value]));
    const focused = root.contains(document.activeElement) ? document.activeElement.getAttribute("name") : null;
    const body = s.error ? [ui.notice(s.error, "err")] : !s.projects?.length && panel !== "capacity" ? [ui.empty("No memory yet", "Projects appear once an agent captures or proposes memory.")] : views[panel]?.(s) ?? [ui.empty("Unknown panel")];
    root.replaceChildren(...[picker(s), ...body].filter(Boolean));
    for (const el of root.querySelectorAll("input[name], textarea[name]")) if (values.has(el.name) && el.name !== "q") el.value = values.get(el.name);
    if (focused) root.querySelector(`[name="${focused}"]`)?.focus();
  });
  return {
    show(id, p = {}) { panel = id; params = p; root.replaceChildren(); },
    hide() {},
    destroy() { root.remove(); },
  };
};
