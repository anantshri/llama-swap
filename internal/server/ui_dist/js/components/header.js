// Navigation header, ported from components/Header.svelte + ConnectionStatus.svelte.
import { el, cleanupAll } from "../dom.js";
import { themeMode, appTitle, isNarrow, toggleTheme, connectionState } from "../theme.js";
import { versionInfo } from "../api.js";
import { currentRoute } from "../router.js";
import { playgroundActivity } from "../playgroundActivity.js";
import { themeIcons } from "../icons.js";

const NAV = [
  { path: "/", label: "Playground" },
  { path: "/models", label: "Models" },
  { path: "/activity", label: "Activity" },
  { path: "/stats", label: "Stats" },
  { path: "/logs", label: "Logs" },
  { path: "/performance", label: "Performance" },
  { path: "/hardware", label: "Hardware" },
  { path: "/settings", label: "Settings" },
];

function isActive(path, current) {
  return path === "/" ? current === "/" : current.startsWith(path);
}

export function Header() {
  const root = el(`
    <header class="app-header">
      <h1 class="app-title" contenteditable="true"></h1>
      <menu class="app-nav">
        ${NAV.map(
          (n) => `<a href="#${n.path}" data-path="${n.path}" class="navlink-top">${n.label}</a>`
        ).join("")}
        <button class="theme-toggle" title="Toggle theme"></button>
        <div class="conn-status" title=""><span class="conn-dot"></span></div>
      </menu>
    </header>
  `);

  const titleEl = root.querySelector(".app-title");
  const links = [...root.querySelectorAll(".navlink-top")];
  const themeBtn = root.querySelector(".theme-toggle");
  const connWrap = root.querySelector(".conn-status");
  const connDot = root.querySelector(".conn-dot");

  function handleTitleChange(newTitle) {
    const sanitized = newTitle.replace(/\n/g, "").trim().substring(0, 64) || "llama-swap";
    appTitle.set(sanitized);
  }
  titleEl.addEventListener("blur", (e) => handleTitleChange(e.currentTarget.textContent || ""));
  titleEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleTitleChange(e.currentTarget.textContent || "");
      e.currentTarget.blur();
    }
  });

  themeBtn.addEventListener("click", toggleTheme);

  const subs = [
    appTitle.subscribe((t) => {
      if (titleEl.textContent !== t) titleEl.textContent = t;
    }),
    themeMode.subscribe((mode) => {
      themeBtn.innerHTML = themeIcons[mode] || themeIcons.system;
      themeBtn.title = `Toggle theme (current: ${mode})`;
    }),
    isNarrow.subscribe((narrow) => root.classList.toggle("header-narrow", narrow)),
    currentRoute.subscribe((cur) => {
      for (const a of links) {
        a.classList.toggle("active", isActive(a.dataset.path, cur));
      }
    }),
    playgroundActivity.subscribe((active) => {
      const pg = links.find((a) => a.dataset.path === "/");
      if (pg) pg.classList.toggle("activity-link", active);
    }),
    connectionState.subscribe(updateConn),
    versionInfo.subscribe(updateConn),
  ];

  function updateConn() {
    const cs = connectionState.get();
    const vi = versionInfo.get();
    connDot.className = "conn-dot conn-" + cs;
    connWrap.title =
      `Event Stream: ${cs ?? "unknown"}\n` +
      `API Version: ${vi?.version ?? "unknown"}\n` +
      `Commit Hash: ${vi?.commit?.substring(0, 7) ?? "unknown"}\n` +
      `Build Date: ${vi?.build_date ?? "unknown"}`;
  }

  return {
    el: root,
    destroy() {
      cleanupAll(subs);
    },
  };
}
