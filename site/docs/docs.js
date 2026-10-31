(() => {
  const root = document.documentElement;

  // Theme: follow the OS unless the visitor picked one (shared with the landing page).
  document.getElementById("theme").addEventListener("click", () => {
    const dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try { localStorage.setItem("kestrel-theme", root.dataset.theme); } catch {}
  });

  // Phone-width navigation.
  const menu = document.getElementById("menu");
  const setOpen = (open) => {
    document.body.classList.toggle("nav-open", open);
    menu.setAttribute("aria-expanded", String(open));
  };
  menu.addEventListener("click", () => setOpen(!document.body.classList.contains("nav-open")));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });

  // Heading anchors.
  for (const h of document.querySelectorAll(".prose h2[id], .prose h3[id]")) {
    const a = document.createElement("a");
    a.className = "anchor";
    a.href = `#${h.id}`;
    a.textContent = "#";
    a.setAttribute("aria-label", `Link to ${h.textContent}`);
    h.prepend(a);
  }

  // Copy buttons on code blocks.
  for (const pre of document.querySelectorAll(".prose pre")) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(pre.querySelector("code").innerText); } catch { return; }
      btn.textContent = "Copied";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    });
    pre.append(btn);
  }

  // Highlight the section in view in "On this page".
  const links = new Map([...document.querySelectorAll(".toc a")].map((a) => [a.hash.slice(1), a]));
  if (!links.size || !("IntersectionObserver" in window)) return;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      for (const a of links.values()) a.classList.toggle("on", a === links.get(en.target.id));
    }
  }, { rootMargin: "-70px 0px -70% 0px" });
  for (const id of links.keys()) {
    const h = document.getElementById(id);
    if (h) io.observe(h);
  }
})();
