// Copy buttons and confirmation prompts. Loaded from our own origin, so the CSP can forbid inline scripts.
document.addEventListener("click", (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    const el = document.getElementById(copy.dataset.copy);
    if (el) navigator.clipboard.writeText(el.textContent.trim()).then(() => {
      const label = copy.textContent;
      copy.textContent = "Copied";
      setTimeout(() => { copy.textContent = label; }, 1500);
    });
  }
  const confirmEl = e.target.closest("[data-confirm]");
  if (confirmEl && !window.confirm(confirmEl.dataset.confirm)) e.preventDefault();
});
