(() => {
  const bridge = window.rakazoSetup;
  document.documentElement.dataset.platform = bridge?.platform ?? "browser";

  const form = document.getElementById("setup");
  const serverUrl = document.getElementById("server-url");
  const accessId = document.getElementById("access-id");
  const accessSecret = document.getElementById("access-secret");
  const status = document.getElementById("status");
  const checkButton = document.getElementById("check");
  const continueButton = document.getElementById("continue");
  const quitButton = document.getElementById("quit");

  function accessInput() {
    return { clientId: accessId.value, clientSecret: accessSecret.value };
  }

  function setStatus(message, tone) {
    status.textContent = message;
    if (tone === undefined) status.removeAttribute("data-tone");
    else status.setAttribute("data-tone", tone);
  }

  function setBusy(busy) {
    checkButton.disabled = busy;
    continueButton.disabled = busy;
  }

  async function save() {
    setBusy(true);
    setStatus("Connecting…");
    try {
      const saved = await bridge.save({ serverUrl: serverUrl.value }, accessInput());
      if (!saved.ok) setStatus(saved.error ?? "Could not save that address.", "error");
    } catch {
      setStatus("Could not save that address. Try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  async function check() {
    const value = serverUrl.value;
    if (value.trim() === "") {
      setStatus("Enter a server address first.", "error");
      return null;
    }

    setBusy(true);
    setStatus("Checking…");
    try {
      const result = await bridge.test(value, accessInput());
      if (result.ok) {
        serverUrl.value = result.url;
        setStatus(`Rakazo answered at ${result.url}.`, "ok");
      } else {
        setStatus(result.error ?? "Could not reach that address.", "error");
      }
      return result;
    } catch {
      setStatus("Could not run the connection check. Try again.", "error");
      return null;
    } finally {
      setBusy(false);
    }
  }

  checkButton.addEventListener("click", () => {
    void check();
  });

  quitButton.addEventListener("click", () => {
    if (bridge === undefined) {
      window.close();
      return;
    }
    void bridge.quit();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save();
  });

  async function init() {
    if (bridge === undefined) {
      setStatus("Setup bridge unavailable.", "error");
      setBusy(true);
      return;
    }

    try {
      const state = await bridge.state();
      if (state === null) throw new Error("Setup is not active");
      if (state.saved !== null) serverUrl.value = state.saved.serverUrl;
      if (state.savedAccessClientId !== null) {
        accessId.value = state.savedAccessClientId;
      }
      if (state.error) setStatus(state.error, "error");
      serverUrl.focus();
    } catch {
      setStatus("Setup could not start. Quit Rakazo and try again.", "error");
      setBusy(true);
    }
  }

  void init();
})();
