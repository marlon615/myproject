/* Draxly website: menu on phones, current page in the menu, old app links, and the contact form. */
(() => {
  // Links from before the website (e.g. emails with /#/billing) belong to the customer app, now at /app.
  if (location.pathname === "/" && location.hash.startsWith("#/")) { location.replace("/app" + location.hash); return; }

  const toggle = document.querySelector(".nav-toggle"), menu = document.getElementById("nav-menu");
  if (toggle && menu) {
    const set = (open) => { menu.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); };
    toggle.addEventListener("click", () => set(!menu.classList.contains("open")));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
    menu.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  }
  const here = location.pathname.replace(/\/$/, "").split("/")[1] || "";
  for (const a of document.querySelectorAll("[data-nav]")) if (a.dataset.nav === here) a.setAttribute("aria-current", "page");

  // Free demo page: show today's cut-off (worked out by the server from today's date).
  const rule = document.querySelector("[data-demo-rule]");
  if (rule) {
    const M = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const name = (ym) => `${M[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;
    fetch("/api/demo/rules").then((r) => (r.ok ? r.json() : null)).then((r) => {
      if (!r?.latestMonth) return;
      for (const [cls, ym] of [[".r-latest", r.latestMonth], [".r-f1", r.forecastMonths[0]], [".r-f3", r.forecastMonths[2]]]) rule.querySelectorAll(cls).forEach((e) => { e.textContent = name(ym); });
      rule.querySelector(".r-today").hidden = false;
    }).catch(() => {});
  }

  const form = document.getElementById("contact-form");
  if (form) {
    const msg = document.getElementById("form-msg"), btn = form.querySelector("button[type=submit]");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = (n) => (form.elements[n]?.value || "").trim();
      msg.className = "form-msg"; msg.textContent = "";
      if (!v("name") || !v("company")) { msg.className = "form-msg err"; msg.textContent = "Please add your name and company."; return; }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v("email"))) { msg.className = "form-msg err"; msg.textContent = "Please check your work email."; return; }
      if (!v("message")) { msg.className = "form-msg err"; msg.textContent = "Please add a short message."; return; }
      const message = [`Topic: ${v("topic") || "General question"}`, v("sales") && `Annual sales: ${v("sales")}`, v("erp") && `Systems: ${v("erp")}`, "", v("message")].filter((x) => x !== false && x !== undefined).join("\n");
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        const res = await fetch("/api/demo/request", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: v("name"), email: v("email"), company: v("company"), title: v("title"), locations: v("locations"), message, website: v("website") }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "That didn't send. Please try again, or email draxlyforecast@gmail.com.");
        form.hidden = true;
        document.getElementById("form-done").hidden = false;
      } catch (err) {
        msg.className = "form-msg err"; msg.textContent = err.message;
        btn.disabled = false; btn.textContent = "Send message";
      }
    });
  }
})();
