const $ = (s) => document.querySelector(s);
const ask = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, (r) => res(r ?? null)));
chrome.storage.local.get(["sites"]).then((saved) => {
  $("#sites").value = Object.entries(saved.sites || {}).map(([o, s]) => `${o} = ${s.project}`).join("\n");
});
$("#save").addEventListener("click", async () => {
  const sites = {};
  for (const line of $("#sites").value.split("\n")) {
    const m = line.match(/^\s*(https?:\/\/[^\s=]+?)\/?\s*=\s*(\S+)\s*$/);
    if (m) sites[m[1]] = { project: m[2] };
  }
  await chrome.storage.local.set({ sites });
  $("#saved").style.opacity = 1;
  setTimeout(() => ($("#saved").style.opacity = 0), 1500);
});
