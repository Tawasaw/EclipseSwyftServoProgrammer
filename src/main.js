import { invoke } from "@tauri-apps/api/core";
import "./styles.css";
import wiringUrl from "./assets/wiring-diagram.png";
import {
  PARAMETERS,
  FLAGS,
  DEFAULTS,
  MAX_TRAVEL_DEGREES,
  toForm,
  fromForm,
  isValid,
  describe,
} from "./params.js";

const PORT_POLL_MS = 2000;
const BAUD_RATES = [9600, 19200, 38400, 57600, 115200, 230400];
const MAX_LOG = 500;

const state = {
  info: { version: "", os: "" },
  ports: [],
  selectedPort: "",
  baud: 115200,
  connected: false,
  connectedPort: null,
  busy: false,
  // When true, newly plugged-in adapters are connected and read automatically. Cleared when the
  // user explicitly disconnects so we don't fight them.
  autoConnect: true,
  form: toForm(DEFAULTS),
  // Last parameters read from / flashed to the servo, used to highlight unsaved edits.
  baseline: null,
};

// ---------------------------------------------------------------- markup

const app = document.querySelector("#app");
app.innerHTML = `
  <header class="header">
    <div class="brand">
      <div>
        <h1>Eclipse30618 Swyft Servo Programmer <span id="version" class="version"></span></h1>
        <p>For SWYFT Robotics servos · FTC Team Eclipse 30618</p>
      </div>
    </div>
    <div class="pill" id="connPill"><span class="dot"></span><span id="connText">Disconnected</span></div>
  </header>

  <section class="card connbar">
    <label class="field grow">
      <span class="caption">Serial port</span>
      <select id="portSelect"></select>
    </label>
    <button id="refreshBtn" class="secondary" type="button">Refresh</button>
    <label class="field">
      <span class="caption">Baud</span>
      <select id="baudSelect">${BAUD_RATES.map((b) => `<option value="${b}">${b}</option>`).join("")}</select>
    </label>
    <button id="connectBtn" class="primary wide" type="button">Connect</button>
  </section>

  <main class="workspace">
    <section class="card params">
      <div class="section-head">
        <h2>Servo parameters</h2>
        <span id="dirtyNote" class="dirty-note hidden">Unsaved changes</span>
      </div>
      <div id="paramList" class="param-list"></div>
    </section>

    <div class="side">
      <section class="card">
        <h2>Travel range</h2>
        <div class="param-row" id="rangeRow">
          <div class="param-label">
            <strong>Total Range</strong>
            <span class="caption">0–${MAX_TRAVEL_DEGREES}°</span>
          </div>
          <input id="rangeSlider" type="range" min="0" max="${MAX_TRAVEL_DEGREES}" step="1" />
          <div class="num-wrap">
            <input id="rangeInput" type="number" min="0" max="${MAX_TRAVEL_DEGREES}" step="1" />
            <span class="unit">°</span>
          </div>
        </div>
        <p class="caption" id="rangeHint">Split evenly between left and right sides.</p>
        <label class="toggle">
          <input id="continuousToggle" type="checkbox" />
          <span class="switch"></span>
          <span>Continuous rotation</span>
        </label>
        <p class="caption">Sets left and right range to 255 for full-speed continuous rotation.</p>
      </section>

      <section class="card">
        <h2>Options</h2>
        <div id="flagList"></div>
      </section>
    </div>
  </main>

  <section class="card actions">
    <button id="readBtn" class="primary" type="button" title="Read parameters from the servo (Ctrl/⌘+R)">Read Servo</button>
    <button id="flashBtn" class="primary" type="button" title="Write parameters to the servo (Ctrl/⌘+Enter)">Flash Servo</button>
    <span class="spacer"></span>
    <button id="defaultsBtn" class="secondary" type="button" title="Load the recommended default servo parameters into the form">Set defaults</button>
    <button id="driverBtn" class="secondary" type="button" title="Open the Silicon Labs CP210x driver download page">USB driver</button>
    <button id="guideBtn" class="secondary" type="button">User guide</button>
  </section>

  <section class="card log">
    <div class="section-head">
      <h2>Activity log</h2>
      <button id="clearLogBtn" class="link" type="button">Clear</button>
    </div>
    <ol id="logList"></ol>
  </section>

  <footer class="statusbar">
    <span id="statusText">Ready.</span>
    <span class="caption" id="lineSettings">115200 8-N-2 • single-wire UART</span>
  </footer>

  <div id="modal" class="modal hidden" role="dialog" aria-modal="true">
    <div class="modal-card" id="modalCard"></div>
  </div>
`;

const $ = (id) => document.getElementById(id);
const el = {
  version: $("version"),
  connPill: $("connPill"),
  connText: $("connText"),
  portSelect: $("portSelect"),
  refreshBtn: $("refreshBtn"),
  baudSelect: $("baudSelect"),
  connectBtn: $("connectBtn"),
  paramList: $("paramList"),
  dirtyNote: $("dirtyNote"),
  rangeRow: $("rangeRow"),
  rangeSlider: $("rangeSlider"),
  rangeInput: $("rangeInput"),
  rangeHint: $("rangeHint"),
  continuousToggle: $("continuousToggle"),
  flagList: $("flagList"),
  readBtn: $("readBtn"),
  flashBtn: $("flashBtn"),
  defaultsBtn: $("defaultsBtn"),
  driverBtn: $("driverBtn"),
  guideBtn: $("guideBtn"),
  clearLogBtn: $("clearLogBtn"),
  logList: $("logList"),
  statusText: $("statusText"),
  lineSettings: $("lineSettings"),
  modal: $("modal"),
  modalCard: $("modalCard"),
};

// ---------------------------------------------------------------- parameter form

const rows = new Map();

for (const def of PARAMETERS) {
  const row = document.createElement("div");
  row.className = "param-row";
  row.title = def.description;
  const sliderMax = def.sliderMax ?? def.max;
  row.innerHTML = `
    <div class="param-label">
      <strong>${def.name}</strong>
      <span class="caption">${def.min}–${def.max}${def.unit ? " " + def.unit : ""}</span>
    </div>
    <input type="range" min="${def.min}" max="${sliderMax}" step="1" aria-label="${def.name}" />
    <div class="num-wrap">
      <input type="number" min="${def.min}" max="${def.max}" step="1" aria-label="${def.name} value" />
      <span class="unit">${def.unit}</span>
    </div>
  `;
  const [slider, input] = row.querySelectorAll("input");
  slider.addEventListener("input", () => setField(def.key, Number(slider.value)));
  input.addEventListener("input", () => {
    const v = input.value.trim() === "" ? NaN : Number(input.value);
    setField(def.key, v, { fromInput: true });
  });
  input.addEventListener("blur", () => {
    if (!isValid(def, state.form[def.key])) return;
    input.value = state.form[def.key];
  });
  el.paramList.appendChild(row);
  rows.set(def.key, { row, slider, input, def });
}

for (const flag of FLAGS) {
  const wrap = document.createElement("div");
  wrap.className = "flag";
  wrap.innerHTML = `
    <label class="toggle">
      <input type="checkbox" data-key="${flag.key}" />
      <span class="switch"></span>
      <span>${flag.name}</span>
    </label>
    <p class="caption">${flag.description}</p>
  `;
  const box = wrap.querySelector("input");
  box.addEventListener("change", () => setField(flag.key, box.checked));
  el.flagList.appendChild(wrap);
  rows.set(flag.key, { row: wrap, input: box, flag });
}

el.rangeSlider.addEventListener("input", () => setField("totalRange", Number(el.rangeSlider.value)));
el.rangeInput.addEventListener("input", () => {
  const v = el.rangeInput.value.trim() === "" ? NaN : Number(el.rangeInput.value);
  setField("totalRange", v, { fromInput: true });
});
el.continuousToggle.addEventListener("change", () => setField("continuous", el.continuousToggle.checked));

function rangeValid(v) {
  return Number.isInteger(v) && v >= 0 && v <= MAX_TRAVEL_DEGREES;
}

function setField(key, value, { fromInput = false } = {}) {
  state.form[key] = value;
  renderForm({ skipInputFor: fromInput ? key : null });
}

function allValid() {
  return PARAMETERS.every((d) => isValid(d, state.form[d.key])) && (state.form.continuous || rangeValid(state.form.totalRange));
}

function isDirty(key) {
  if (!state.baseline) return false;
  if (key === "totalRange") return !state.form.continuous && state.form.totalRange !== state.baseline.totalRange;
  return state.form[key] !== state.baseline[key];
}

function renderForm({ skipInputFor = null } = {}) {
  for (const [key, r] of rows) {
    const value = state.form[key];
    if (r.def) {
      const ok = isValid(r.def, value);
      r.row.classList.toggle("invalid", !ok);
      if (ok) r.slider.value = value;
      if (key !== skipInputFor) r.input.value = Number.isFinite(value) ? value : "";
    } else {
      r.input.checked = !!value;
    }
    r.row.classList.toggle("dirty", isDirty(key));
  }

  const continuous = state.form.continuous;
  el.continuousToggle.checked = continuous;
  el.rangeSlider.disabled = continuous;
  el.rangeInput.disabled = continuous;
  el.rangeRow.classList.toggle("disabled", continuous);
  el.rangeRow.classList.toggle("invalid", !continuous && !rangeValid(state.form.totalRange));
  el.rangeRow.classList.toggle("dirty", isDirty("totalRange") || isDirty("continuous"));
  if (rangeValid(state.form.totalRange)) el.rangeSlider.value = state.form.totalRange;
  if (skipInputFor !== "totalRange") el.rangeInput.value = Number.isFinite(state.form.totalRange) ? state.form.totalRange : "";
  el.rangeHint.textContent = continuous
    ? "Continuous rotation: left and right range are both 255."
    : `Split evenly between left and right sides (${fromForm(state.form).bigAngle} per side).`;

  const dirty = state.baseline && [...rows.keys(), "totalRange", "continuous"].some(isDirty);
  el.dirtyNote.classList.toggle("hidden", !dirty);
  renderControls();
}

// ---------------------------------------------------------------- connection UI

function shortPortName(name) {
  return name.replace(/^\/dev\/(cu\.|tty\.)?/, "");
}

function renderPorts() {
  const current = state.selectedPort;
  el.portSelect.innerHTML = state.ports.length
    ? state.ports
        .map((p) => {
          const label = p.description ? `${shortPortName(p.name)} — ${p.description}` : shortPortName(p.name);
          return `<option value="${escapeHtml(p.name)}">${escapeHtml(label)}</option>`;
        })
        .join("")
    : `<option value="">No serial ports found</option>`;
  el.portSelect.value = current;
}

function renderControls() {
  const canTalk = !state.busy && (state.connected || !!state.selectedPort);
  el.readBtn.disabled = !canTalk;
  el.flashBtn.disabled = !canTalk || !allValid();
  el.connectBtn.disabled = state.busy || (!state.connected && !state.selectedPort);
  el.connectBtn.textContent = state.connected ? "Disconnect" : "Connect";
  el.portSelect.disabled = state.busy || state.connected;
  el.baudSelect.disabled = state.busy || state.connected;
  el.refreshBtn.disabled = state.busy;
  document.body.classList.toggle("busy", state.busy);

  el.connPill.classList.toggle("on", state.connected);
  el.connText.textContent = state.connected ? `Connected • ${shortPortName(state.connectedPort)}` : "Disconnected";
  el.lineSettings.textContent = `${state.baud} 8-N-2 • single-wire UART`;
}

// ---------------------------------------------------------------- log

function log(level, message) {
  const li = document.createElement("li");
  li.className = level;
  const time = new Date().toLocaleTimeString([], { hour12: false });
  li.innerHTML = `<time>${time}</time><span></span>`;
  li.querySelector("span").textContent = message;
  el.logList.appendChild(li);
  while (el.logList.children.length > MAX_LOG) el.logList.firstChild.remove();
  el.logList.scrollTop = el.logList.scrollHeight;
  el.statusText.textContent = message;
  el.statusText.className = level;
}

// ---------------------------------------------------------------- backend calls

function errorMessage(err) {
  if (err && typeof err === "object" && "message" in err) return err.message;
  return String(err);
}

async function syncStatus() {
  const s = await invoke("connection_status");
  state.connected = s.connected;
  state.connectedPort = s.port ?? null;
  renderControls();
}

async function refreshPorts({ quiet = false } = {}) {
  const before = new Set(state.ports.map((p) => p.name));
  state.ports = await invoke("list_ports");
  const names = state.ports.map((p) => p.name);

  if (!names.includes(state.selectedPort)) {
    state.selectedPort = state.ports.find((p) => p.score > 0)?.name ?? names[0] ?? "";
  }
  renderPorts();

  // The adapter we were connected to vanished (unplugged).
  if (state.connected && !names.includes(state.connectedPort)) {
    await invoke("disconnect");
    log("warning", `${shortPortName(state.connectedPort)} was unplugged.`);
    state.connected = false;
    state.connectedPort = null;
    state.autoConnect = true;
  }

  if (!quiet) {
    if (state.ports.length) log("info", `Found ${state.ports.length} serial port(s).`);
    else log("warning", `No serial ports found. ${driverHint()}`);
  }
  renderControls();
  return state.ports.filter((p) => !before.has(p.name));
}

async function connect() {
  const port = state.selectedPort;
  if (!port) {
    log("warning", "Select a serial port first.");
    return false;
  }
  try {
    const s = await invoke("connect", { port, baud: state.baud });
    state.connected = s.connected;
    state.connectedPort = s.port;
    log("success", `Connected to ${shortPortName(port)} at ${state.baud} baud (8-N-2).`);
    return true;
  } catch (err) {
    state.connected = false;
    log("error", errorMessage(err));
    return false;
  } finally {
    renderControls();
  }
}

async function disconnect() {
  await invoke("disconnect");
  state.connected = false;
  state.connectedPort = null;
  state.autoConnect = false;
  log("info", "Disconnected.");
  renderControls();
}

async function ensureConnected() {
  return state.connected || (await connect());
}

/** Runs one serial operation with the UI locked. */
async function exclusive(fn) {
  if (state.busy) return;
  state.busy = true;
  renderControls();
  try {
    await fn();
  } finally {
    state.busy = false;
    await syncStatus().catch(() => {});
    renderControls();
  }
}

function describeTransportError(op, err) {
  switch (err?.kind) {
    case "timeout":
      return op === "read"
        ? `Read timed out. No reply from the servo — check wiring and power (${err.message}).`
        : `Write timed out. No acknowledgement from the servo — check the connection (${err.message}).`;
    case "io":
      return `${op === "read" ? "Read" : "Write"} error: ${err.message}. The adapter may have been unplugged.`;
    default:
      return `${op === "read" ? "Read" : "Write"} error: ${errorMessage(err)}`;
  }
}

async function readServo({ quietSuccess = false } = {}) {
  if (!(await ensureConnected())) return null;
  try {
    if (!quietSuccess) log("info", "Reading parameters from servo…");
    const { params } = await invoke("read_servo");
    if (!quietSuccess) {
      state.form = toForm(params);
      state.baseline = { ...state.form };
      renderForm();
      log("success", "Read successful. Parameters loaded from servo.");
      log("info", `Values → ${describe(params)}.`);
    }
    return params;
  } catch (err) {
    log("error", describeTransportError("read", err));
    return null;
  }
}

async function flashServo() {
  if (!allValid()) {
    log("warning", "One or more parameters are out of range. Fix the highlighted fields before flashing.");
    return;
  }
  if (!state.baseline) {
    const ok = await confirmDialog(
      "Flash without reading first?",
      "You haven't read this servo yet. Flashing will overwrite every setting on the servo with the values shown in the form.",
      "Flash anyway",
    );
    if (!ok) return;
  }
  if (!(await ensureConnected())) return;

  const params = fromForm(state.form);
  try {
    log("info", "Writing parameters to servo…");
    await invoke("write_servo", { params });
    log("success", "Write successful. The servo acknowledged the new parameters.");
  } catch (err) {
    log("error", describeTransportError("write", err));
    return;
  }

  // Read back to confirm the servo stored what we sent.
  const readBack = await readServo({ quietSuccess: true });
  if (!readBack) {
    log("warning", "Could not read back the servo to verify the flash.");
  } else if (Object.keys(params).every((k) => params[k] === readBack[k])) {
    log("success", "Verified: the servo reports the flashed values.");
  } else {
    const diffs = Object.keys(params)
      .filter((k) => params[k] !== readBack[k])
      .map((k) => `${k} sent ${params[k]}, servo has ${readBack[k]}`);
    log("warning", `Verification mismatch: ${diffs.join("; ")}.`);
  }
  if (readBack && Object.keys(params).some((k) => params[k] !== readBack[k])) {
    // Keep the user's edits; highlight what differs from what the servo actually stored.
    state.baseline = toForm(readBack);
  } else {
    state.form = toForm(readBack ?? params);
    state.baseline = { ...state.form };
  }
  renderForm();
}

async function autoDetect() {
  const candidate = state.ports.find((p) => p.score > 0);
  if (!candidate) {
    log("warning", `No USB-to-UART adapter detected. Plug in the servo programmer. ${driverHint()}`);
    return;
  }
  state.selectedPort = candidate.name;
  renderPorts();
  log("info", `Auto-detect selected ${shortPortName(candidate.name)} — ${candidate.description || "serial port"}. Verifying…`);
  await exclusive(() => readServo());
}

function driverHint() {
  if (state.info.os === "windows") return 'If your programmer isn\'t listed, click "USB driver".';
  if (state.info.os === "linux") return "Check that your user is in the dialout group.";
  return "";
}

// ---------------------------------------------------------------- modal dialogs

let modalResolve = null;

function openModal(html, { wide = false } = {}) {
  el.modalCard.className = `modal-card${wide ? " wide" : ""}`;
  el.modalCard.innerHTML = html;
  el.modal.classList.remove("hidden");
  el.modalCard.querySelector("[data-autofocus]")?.focus();
}

function closeModal(result = false) {
  el.modal.classList.add("hidden");
  el.modalCard.innerHTML = "";
  modalResolve?.(result);
  modalResolve = null;
}

function confirmDialog(title, body, okLabel) {
  openModal(`
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(body)}</p>
    <div class="modal-actions">
      <button class="secondary" data-close="false" data-autofocus type="button">Cancel</button>
      <button class="primary" data-close="true" type="button">${escapeHtml(okLabel)}</button>
    </div>
  `);
  return new Promise((resolve) => (modalResolve = resolve));
}

el.modal.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close]");
  if (btn) closeModal(btn.dataset.close === "true");
  else if (e.target === el.modal) closeModal(false);
});

function showGuide() {
  const os = state.info.os;
  const findPort =
    os === "windows"
      ? `<li><b>Find the port:</b> the programmer appears as “Silicon Labs CP210x USB to UART Bridge (COMx)”. If it doesn't, click “USB driver” to open the Silicon Labs download page, then download and install the <b>CP210x Windows Drivers</b>. This is only needed once per computer.</li>`
      : os === "macos"
        ? `<li><b>Find the port:</b> no driver is needed on macOS. The programmer appears as <code>usbserial-…</code> or <code>SLAB_USBtoUART</code>.</li>`
        : `<li><b>Find the port:</b> no driver is needed on Linux. The programmer appears as <code>/dev/ttyUSB0</code>. If it can't be opened, add yourself to the <code>dialout</code> group and log in again.</li>`;

  openModal(
    `
    <div class="guide-head">
      <h3>User guide</h3>
      <button class="link" data-close="false" type="button">Close</button>
    </div>
    <div class="guide-body">
      <p>This guide explains the settings and functionality of the Eclipse30618 Swyft Servo Programmer.</p>
      <h4>Getting started</h4>
      <ol class="steps">
        <li><b>Connect the programmer</b> to a USB port.</li>
        <li><b>Connect the servo</b> to the programmer. Match the gray wire (servo side) to the white wire (programmer side), as shown below.</li>
        ${findPort}
        <li><b>Select the port:</b> the app picks the programmer automatically. Otherwise choose it at the top of the window and click Connect.</li>
        <li><b>Read servo:</b> click “Read Servo” to retrieve the current settings. If the values don't populate, check the wiring and power.</li>
        <li><b>Modify settings</b> as needed (see below). Changed fields are highlighted until flashed.</li>
        <li><b>Flash servo:</b> click “Flash Servo” to save. The app reads the servo back to verify the new settings.</li>
        <li><b>Unplug</b> the servo from the programmer.</li>
      </ol>
      <figure><img src="${wiringUrl}" alt="Wiring diagram" /><figcaption>USB-to-UART adapter wired to a SWYFT servo.</figcaption></figure>

      <h4>Setting explanations</h4>
      <p><b>PID coefficients</b> fine-tune the servo's response characteristics.</p>
      <dl>
        <dt>P (Proportional)</dt><dd>How strongly the servo reacts to the error between its current and target position. Higher P = faster response, but can lead to overshoot or oscillation.</dd>
        <dt>I (Integral)</dt><dd>Addresses accumulated error over time, eliminating steady-state errors. Higher I = eliminates steady-state error faster, but can make the system less stable.</dd>
        <dt>D (Derivative)</dt><dd>Dampens the servo's response, reducing overshoot and oscillation. Higher D = smoother response, but can slow down the servo.</dd>
        <dt>Min Signal</dt><dd>The PWM signal value corresponding to the servo's leftmost position.</dd>
        <dt>Max Signal</dt><dd>The PWM signal value corresponding to the servo's rightmost position.</dd>
        <dt>Middle Signal</dt><dd>The PWM signal value for the servo's center position. It's generally recommended to leave this at 1500.</dd>
        <dt>Dead Zone</dt><dd>How close the servo needs to be to its target before it stops actively trying to reach it. A smaller dead zone means higher precision but may lead to more jitter.</dd>
        <dt>Max Power</dt><dd>Maximum power output to the servo motor, out of 500 (e.g. 90% = 450).</dd>
        <dt>Stall Protection</dt><dd>Automatically shuts off the servo if it's stalled (blocked from moving) for more than 10 seconds. This helps prevent damage to the servo and electronics.</dd>
        <dt>Ramp Mode</dt><dd>Limits the initial current surge when the servo starts up, protecting the servo and the device controlling it from high current draw.</dd>
        <dt>Total Range</dt><dd>The total mechanical travel of the servo (0–320°), split evenly between the left and right sides (e.g. 270° uses 111 per side, 320° uses 130 per side).</dd>
        <dt>Direction</dt><dd>Reverses the servo's direction, swapping left and right.</dd>
      </dl>

      <h4>Continuous rotation mode</h4>
      <p>Enable “Continuous rotation” to configure the servo for continuous rotation. This sets both left and right range to 255.</p>
      <dl>
        <dt>Full speed only</dt><dd>Continuous rotation supports full speed in either direction only. Partial speed control is not available.</dd>
        <dt>Home position</dt><dd>Sending a position signal of 1500 (or 0.5 in code) returns the servo to its neutral (home) position.</dd>
        <dt>Stopping</dt><dd>To stop the servo in continuous rotation mode, use the disable-PWM command in your code.</dd>
      </dl>

      <h4>Keyboard shortcuts</h4>
      <p><kbd>${modKey()}</kbd>+<kbd>R</kbd> Read servo &nbsp;·&nbsp; <kbd>${modKey()}</kbd>+<kbd>Enter</kbd> Flash servo</p>
    </div>
  `,
    { wide: true },
  );
}

const modKey = () => (state.info.os === "macos" ? "⌘" : "Ctrl");

// ---------------------------------------------------------------- events

el.portSelect.addEventListener("change", () => {
  state.selectedPort = el.portSelect.value;
  renderControls();
});
el.baudSelect.addEventListener("change", () => {
  state.baud = Number(el.baudSelect.value);
  renderControls();
});
el.refreshBtn.addEventListener("click", () => refreshPorts());
el.connectBtn.addEventListener("click", () =>
  exclusive(async () => {
    if (state.connected) await disconnect();
    else if (await connect()) state.autoConnect = true;
  }),
);
el.readBtn.addEventListener("click", () => exclusive(() => readServo()));
el.flashBtn.addEventListener("click", () => exclusive(flashServo));
el.defaultsBtn.addEventListener("click", () => {
  state.form = toForm(DEFAULTS);
  renderForm();
  log("info", 'Loaded default parameters. Click "Flash Servo" to write them to the servo.');
});
el.driverBtn.addEventListener("click", async () => {
  try {
    const url = await invoke("open_driver_page");
    const note =
      state.info.os === "windows"
        ? 'Download "CP210x Windows Drivers", unzip it, run the installer, then reconnect the programmer.'
        : "This driver is normally only needed on Windows; macOS and Linux include one.";
    log("info", `Opened ${url} in your browser. ${note}`);
  } catch (err) {
    log("error", errorMessage(err));
  }
});
el.guideBtn.addEventListener("click", showGuide);
el.clearLogBtn.addEventListener("click", () => (el.logList.innerHTML = ""));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !el.modal.classList.contains("hidden")) {
    closeModal(false);
    return;
  }
  const mod = e.metaKey || e.ctrlKey;
  if (!mod || !el.modal.classList.contains("hidden")) return;
  if (e.key.toLowerCase() === "r") {
    e.preventDefault(); // also suppresses webview reload
    if (!el.readBtn.disabled) el.readBtn.click();
  } else if (e.key === "Enter") {
    e.preventDefault();
    if (!el.flashBtn.disabled) el.flashBtn.click();
  }
});

// Watch for adapters being plugged in or removed.
async function pollPorts() {
  if (!state.busy) {
    try {
      const added = await refreshPorts({ quiet: true });
      const adapter = added.find((p) => p.score > 0);
      if (adapter && !state.connected && state.autoConnect && !state.busy) {
        log("info", `Detected ${shortPortName(adapter.name)} — ${adapter.description || "serial port"}.`);
        state.selectedPort = adapter.name;
        renderPorts();
        await exclusive(() => readServo());
      }
    } catch {
      // Port enumeration can fail transiently while a device is (dis)connecting.
    }
  }
  setTimeout(pollPorts, PORT_POLL_MS);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------- startup

async function init() {
  el.baudSelect.value = String(state.baud);
  renderForm();
  try {
    state.info = await invoke("app_info");
    el.version.textContent = `v${state.info.version}`;
  } catch {
    // Not running inside Tauri (e.g. plain `npm run dev` in a browser).
    log("warning", "Backend unavailable — run with `npm run tauri:dev`.");
    return;
  }
  document.body.dataset.os = state.info.os;
  log("info", "Welcome to Eclipse30618 Swyft Servo Programmer. Detecting the servo programmer…");
  await refreshPorts({ quiet: true });
  await autoDetect();
  setTimeout(pollPorts, PORT_POLL_MS);
}

init();
