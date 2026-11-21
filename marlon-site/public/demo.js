/* Demo page: tap a chapter to jump to that moment in the video. */
(() => {
  const video = document.getElementById("demo-video");
  if (!video) return;
  for (const b of document.querySelectorAll(".chapters [data-t]")) {
    b.addEventListener("click", () => {
      video.currentTime = Number(b.dataset.t);
      video.play().catch(() => {});
      if (window.matchMedia("(max-width: 899px)").matches) video.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
})();
