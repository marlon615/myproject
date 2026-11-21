/* Marlon website: the menu on phones, the current page in the menu, the contact form and the price calculator. */
(() => {
  const toggle = document.querySelector(".nav-toggle"), menu = document.getElementById("nav-menu");
  if (toggle && menu) {
    const set = (open) => { menu.classList.toggle("open", open); toggle.setAttribute("aria-expanded", String(open)); };
    toggle.addEventListener("click", () => set(!menu.classList.contains("open")));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") set(false); });
    menu.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  }
  const here = location.pathname.replace(/\/$/, "").split("/")[1] || "";
  for (const a of document.querySelectorAll("[data-nav]")) if (a.dataset.nav === here) a.setAttribute("aria-current", "page");

  // ── Price calculator (the same table and rounding as the Marlon app's pricing.js) ──
  const TIERS = [[1, 4, 0], [5, 9, 10], [10, 24, 15], [25, 49, 20], [50, 99, 25], [100, Infinity, 30]];
  const usd = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const price = (reps, unitCents) => {
    const pct = TIERS.find(([a, b]) => reps >= a && reps <= b)[2];
    const gross = reps * unitCents, disc = Math.round(gross * pct / 100);
    return { pct, gross, disc, net: gross - disc };
  };
  const calc = document.querySelector("[data-calc]");
  if (calc) {
    const num = calc.querySelector("#calc-reps"), range = calc.querySelector("[data-calc-range]");
    const out = (k, v) => { const e = calc.querySelector(`[data-out="${k}"]`); if (e) e.textContent = v; };
    const draw = (from) => {
      let n = Math.floor(Number(from.value));
      if (!Number.isFinite(n) || n < 1) return;
      n = Math.min(n, 10000);
      if (from === num) range.value = String(Math.min(n, 150)); else num.value = String(n);
      for (const [key, unit, label] of [["m", 7900, "$79.00"], ["p", 2500, "$25.00"]]) {
        const p = price(n, unit);
        out(key === "m" ? "marlon" : "pro", usd(p.net));
        out(`${key}-gross-label`, `${n} rep${n === 1 ? "" : "s"} × ${label}`);
        out(`${key}-gross`, usd(p.gross));
        out(`${key}-disc-label`, p.pct ? `Team discount ${p.pct}%` : "Team discount (under 5 reps)");
        out(`${key}-disc`, p.pct ? `−${usd(p.disc)}` : "none");
      }
    };
    num.addEventListener("input", () => draw(num));
    range.addEventListener("input", () => draw(range));
    draw(num);
  }

  // ── Contact form ──
  const form = document.getElementById("contact-form");
  if (form) {
    const topicFor = { buy: "Buy Marlon for my business", pro: "Marlon Pro", help: "Help with Marlon I already have" };
    const t = new URLSearchParams(location.search).get("topic");
    if (topicFor[t]) form.elements.topic.value = topicFor[t];
    const msg = document.getElementById("form-msg"), btn = form.querySelector("button[type=submit]");
    const fail = (text, field) => {
      msg.textContent = text;
      for (const el of form.querySelectorAll(".is-wrong")) el.classList.remove("is-wrong");
      if (field && form.elements[field]) { form.elements[field].classList.add("is-wrong"); form.elements[field].focus(); }
    };
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = (n) => (form.elements[n]?.value || "").trim();
      msg.textContent = "";
      if (!v("name")) return fail("Please add your name.", "name");
      if (!v("company")) return fail("Please add your company or business name.", "company");
      if (!/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/.test(v("email"))) return fail("Please check your email address.", "email");
      if (v("message").length < 2) return fail("Please add a short message.", "message");
      btn.disabled = true; btn.textContent = "Sending…";
      try {
        const res = await fetch("/api/contact", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: v("name"), company: v("company"), email: v("email"), role: v("role"), topic: v("topic"), reps: v("reps"), message: v("message"), website: v("website"), page: location.pathname }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) { btn.disabled = false; btn.textContent = "Send message"; return fail(data.error || "That didn’t send. Please try again, or email marlonapp.sales@gmail.com.", data.field); }
        form.hidden = true;
        const done = document.getElementById("form-done");
        done.hidden = false; done.focus();
      } catch {
        btn.disabled = false; btn.textContent = "Send message";
        fail("No connection. Please try again, or email marlonapp.sales@gmail.com.");
      }
    });
  }
})();
