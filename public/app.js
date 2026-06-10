// Helpers partagés par toutes les pages
const $ = (s, root) => (root || document).querySelector(s);
const $$ = (s, root) => [...(root || document).querySelectorAll(s)];

async function api(url, opts) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function renderNav(active) {
  const links = [
    ["index.html", "Tableau de bord"],
    ["campaigns.html", "Campagnes"],
    ["settings.html", "Paramètres"],
  ];
  document.body.insertAdjacentHTML(
    "afterbegin",
    `<nav><span class="brand">📬 Sequence Mail</span>` +
      links
        .map(([href, label]) => `<a href="${href}" class="${href === active ? "active" : ""}">${label}</a>`)
        .join("") +
      `</nav>`
  );
}

const STATUS_LABELS = {
  pending: "en attente",
  in_progress: "en cours",
  replied: "a répondu",
  opted_out: "désinscrit",
  completed: "terminé",
  stopped: "stoppé",
  failed: "échec",
  active: "active",
  paused: "en pause",
};

function pill(status) {
  return `<span class="pill ${esc(status)}">${esc(STATUS_LABELS[status] || status)}</span>`;
}
