const statusText = {
  match: "有",
  param: "参数不符",
  missing: "没有",
};

let stock = [];
let resultRows = [];
let filter = "all";

const stockCount = document.querySelector("#stockCount");
const stockBody = document.querySelector("#stockBody");
const stockSource = document.querySelector("#stockSource");
const stockSearch = document.querySelector("#stockSearch");
const result = document.querySelector("#result");
const resultBody = document.querySelector("#resultBody");
const summary = document.querySelector("#summary");
const checkError = document.querySelector("#checkError");
const fileInput = document.querySelector("#file");
const drop = document.querySelector("#drop");

function text(value) {
  const cleaned = String(value ?? "").trim();
  return cleaned || "—";
}

function qty(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (Math.abs(number - Math.round(number)) < 1e-9) return String(Math.round(number));
  return String(Math.round(number * 1000) / 1000);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function norm(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").replace(/\uFEFF/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}

function samePart(left, right) {
  return norm(left.comment) === norm(right.comment)
    && norm(left.footprint) === norm(right.footprint)
    && norm(left.value) === norm(right.value)
    && norm(left.mpn) === norm(right.mpn);
}

function stockSide(row) {
  if (!row.stock.length) return "—";
  if (row.status === "param") {
    return row.stock.map((item) => {
      const note = String(item.note || "").trim();
      const mpn = String(item.mpn || "").trim();
      const label = `${note || "未填写备注"} + ${mpn || "—"}`;
      return `<span class="mpn">${escapeHtml(label)}</span>`;
    }).join("");
  }
  return row.stock.map((item) => {
    const maker = item.manufacturer ? `<small>${escapeHtml(item.manufacturer)}</small>` : "";
    return `<span class="mpn">${escapeHtml(text(item.mpn))}${maker}</span>`;
  }).join("");
}

function stockQty(row) {
  if (!row.stock.length) return "—";
  const total = row.stock.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  return qty(total);
}

function renderStock() {
  const query = stockSearch.value.trim().toLowerCase();
  const rows = stock.filter((part) => {
    if (!query) return true;
    return [part.comment, part.footprint, part.value, part.mpn, part.note, part.manufacturer, part.supplier_part]
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
  stockBody.innerHTML = rows.length
    ? rows.map((part) => `
      <tr>
        <td>${escapeHtml(text(part.comment))}</td>
        <td>${escapeHtml(text(part.footprint))}</td>
        <td>${escapeHtml(text(part.value))}</td>
        <td>${qty(part.qty)}</td>
        <td><input class="note-input" data-note-id="${part.id}" value="${escapeHtml(part.note || "")}" placeholder="入库备注"></td>
        <td>${escapeHtml(text(part.mpn))}</td>
        <td>${escapeHtml(text(part.manufacturer))}</td>
        <td>${escapeHtml(text(part.supplier_part))}</td>
      </tr>
    `).join("")
    : `<tr><td class="empty" colspan="8">没有符合的零件</td></tr>`;
}

function missingExportRows() {
  return resultRows.filter((row) => row.status === "missing" && !row.ignored);
}

function renderExportCount() {
  const count = missingExportRows().length;
  const button = document.querySelector("#exportMissing");
  button.textContent = `导出没有的 BOM（${count}）`;
  button.disabled = count === 0;
}

function renderResult() {
  const rows = resultRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => filter === "all" || row.status === filter);
  resultBody.innerHTML = rows.length
    ? rows.map(({ row, index }) => `
      <tr class="${row.status}${row.ignored ? " ignored" : ""}">
        <td><span class="chip">${row.ignored ? "已忽略" : statusText[row.status]}</span></td>
        <td>${escapeHtml(text(row.designator))}</td>
        <td>${escapeHtml(text(row.comment))}</td>
        <td>${escapeHtml(text(row.footprint))}</td>
        <td>${escapeHtml(text(row.value))}</td>
        <td>${stockQty(row)}</td>
        <td>${escapeHtml(text(row.mpn))}</td>
        <td>${stockSide(row)}</td>
        <td>${row.status === "missing" ? `<button type="button" class="ghost" data-ignore="${index}">${row.ignored ? "取消忽略" : "忽略"}</button>` : ""}</td>
      </tr>
    `).join("")
    : `<tr><td class="empty" colspan="9">这一类里没有行</td></tr>`;
  renderExportCount();
}

function csvCell(value) {
  const textValue = String(value ?? "");
  if (/[",\n\r]/.test(textValue)) return `"${textValue.replace(/"/g, '""')}"`;
  return textValue;
}

function exportMissing() {
  const rows = missingExportRows();
  if (!rows.length) return;
  const header = ["No.", "Quantity", "Comment", "Designator", "Footprint", "Value", "Manufacturer Part"];
  const lines = [header.join(",")];
  rows.forEach((row, index) => {
    lines.push([
      index + 1,
      row.qty,
      row.comment,
      row.designator,
      row.footprint,
      row.value,
      row.mpn,
    ].map(csvCell).join(","));
  });
  const blob = new Blob([`\uFEFF${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "库存没有的BOM.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

function renderSummary(counts) {
  summary.innerHTML = `
    <div><b>${counts.total}</b>全部</div>
    <div class="match"><b>${counts.match}</b>有</div>
    <div class="param"><b>${counts.param}</b>参数不符</div>
    <div class="missing"><b>${counts.missing}</b>没有</div>
  `;
}

async function loadStock() {
  const response = await fetch("/api/stock");
  const data = await response.json();
  stock = data.parts || [];
  stockCount.textContent = `库存 ${stock.length} 种`;
  const source = data.source ? data.source.split("\\").pop() : "";
  stockSource.textContent = source ? `来源 ${source}，数量取自 Quantity 列` : "";
  renderStock();
}

async function checkFile(file) {
  checkError.hidden = true;
  const response = await fetch("/api/check", {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: await file.arrayBuffer(),
  });
  const data = await response.json();
  if (!response.ok) {
    checkError.hidden = false;
    checkError.textContent = data.error || "对照失败";
    return;
  }
  resultRows = data.rows;
  filter = "all";
  document.querySelectorAll(".filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === "all");
  });
  result.hidden = false;
  renderSummary(data.summary);
  renderResult();
}

document.querySelectorAll(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === button));
    document.querySelector("#panel-check").hidden = button.dataset.tab !== "check";
    document.querySelector("#panel-stock").hidden = button.dataset.tab !== "stock";
  });
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    filter = button.dataset.filter;
    document.querySelectorAll(".filter").forEach((item) => item.classList.toggle("active", item === button));
    renderResult();
  });
});

drop.addEventListener("submit", (event) => event.preventDefault());
drop.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = "";
  if (file) checkFile(file);
});
drop.addEventListener("dragover", (event) => {
  event.preventDefault();
  drop.classList.add("over");
});
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (event) => {
  event.preventDefault();
  drop.classList.remove("over");
  const file = event.dataTransfer.files[0];
  if (file) checkFile(file);
});
stockSearch.addEventListener("input", renderStock);

stockBody.addEventListener("change", async (event) => {
  const input = event.target.closest("[data-note-id]");
  if (!input) return;
  const note = input.value.trim();
  const response = await fetch(`/api/parts/${input.dataset.noteId}/note`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ note }),
  });
  if (!response.ok) return;
  const part = stock.find((item) => String(item.id) === input.dataset.noteId);
  if (!part) return;
  part.note = note;
  for (const row of resultRows) {
    for (const item of row.stock || []) {
      if (samePart(item, part)) item.note = note;
    }
  }
  if (!result.hidden) renderResult();
});

document.querySelector("#inbound").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector("#inboundMsg");
  const payload = Object.fromEntries(new FormData(form));
  const response = await fetch("/api/inbound", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  message.classList.toggle("error", !response.ok);
  if (!response.ok) {
    message.textContent = data.error || "入库失败";
    return;
  }
  message.textContent = `已入库 ${data.part.comment}，数量 ${qty(data.part.qty)}`;
  form.elements.note.value = "";
  form.elements.qty.value = "1";
  await loadStock();
});

resultBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-ignore]");
  if (!button) return;
  const row = resultRows[Number(button.dataset.ignore)];
  const ignored = !row.ignored;
  const response = await fetch("/api/ignore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      comment: row.comment,
      footprint: row.footprint,
      value: row.value,
      mpn: row.mpn,
      ignored,
    }),
  });
  if (!response.ok) return;
  for (const item of resultRows) {
    if (samePart(item, row)) item.ignored = ignored;
  }
  renderResult();
});

document.querySelector("#exportMissing").addEventListener("click", exportMissing);

loadStock().catch(() => {
  stockCount.textContent = "库存读取失败";
});
