"use strict";

const widget = document.querySelector("#captcha");
const result = document.querySelector("#result");
const start = document.querySelector("#start");
const replay = document.querySelector("#replay");
let token;
let submitted;

async function verify(response) {
  const reply = await fetch("/api/v1/sessions", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({country: "de", captchaToken: response}),
  });
  const data = await reply.json();
  return {status: reply.status, created: reply.ok && Boolean(data.session), code: data.code};
}

async function init() {
  const reply = await fetch("/api/v1/config");
  if (!reply.ok) throw new Error("Staging configuration is unavailable");
  const {captchaSiteKey} = await reply.json();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(captchaSiteKey)) throw new Error("Invalid staging site key");
  widget.setAttribute("data-cap-api-endpoint", `${location.origin}/${captchaSiteKey}/`);
  window.CAP_CUSTOM_WASM_URL = "/assets/cap_wasm_bg.wasm";
  window.CAP_CUSTOM_HASHWX_URL = "/assets/hashwx.wasm";
  window.CAP_ISOLATE = true;
  widget.addEventListener("solve", (event) => {
    token = event.detail.token;
    start.disabled = false;
    result.textContent = "Challenge solved. Create a staging session to verify the token.";
  });
  widget.addEventListener("error", () => {
    start.disabled = true;
    result.textContent = "Challenge unavailable or rejected.";
  });
  const script = document.createElement("script");
  script.src = "/assets/widget.js";
  script.onerror = () => { result.textContent = "Could not load the self-hosted widget."; };
  document.head.append(script);
  result.textContent = "Complete the challenge to start.";
}

start.onclick = async () => {
  start.disabled = true;
  submitted = token;
  try {
    const response = await verify(submitted);
    result.textContent = response.created
      ? "PASS: Cap verified and Shifter created a staging session."
      : `Session rejected: ${response.code || response.status}`;
    replay.disabled = !response.created;
  } catch {
    result.textContent = "Staging verifier unavailable.";
  }
};

replay.onclick = async () => {
  replay.disabled = true;
  try {
    const response = await verify(submitted);
    result.textContent = response.status === 403 && response.code === "CAPTCHA_REJECTED"
      ? "PASS: Shifter rejected reuse of the solved token."
      : "FAIL: replay was not rejected as expected.";
  } catch {
    result.textContent = "Could not check replay.";
  }
};

init().catch(() => { result.textContent = "Staging configuration is unavailable."; });
