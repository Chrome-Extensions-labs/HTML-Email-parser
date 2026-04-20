(() => {
  function createStatusNode(message, className) {
    const node = document.createElement("div");
    node.className = className;
    node.textContent = message;
    return node;
  }

  function renderStatus(container, message, className = "status") {
    container.replaceChildren(createStatusNode(message, className));
  }

  function renderEmailList(container, emails, onCopy) {
    container.innerHTML = "";

    if (!emails.length) {
      renderStatus(container, "No emails found on this page.", "status status-empty");
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const email of emails) {
      const row = document.createElement("div");
      row.className = "email-row";

      const emailText = document.createElement("div");
      emailText.className = "email-text";
      emailText.textContent = email;

      const buttonGroup = document.createElement("div");
      buttonGroup.className = "btn-group";

      const copyButton = document.createElement("button");
      copyButton.className = "btn";
      copyButton.type = "button";
      copyButton.textContent = "Copy";
      copyButton.addEventListener("click", () => onCopy(email));

      const mailButton = document.createElement("a");
      mailButton.className = "btn btn-primary";
      mailButton.href = `mailto:${email}`;
      mailButton.textContent = "Mail";
      mailButton.target = "_blank";
      mailButton.rel = "noopener noreferrer";

      buttonGroup.append(copyButton, mailButton);
      row.append(emailText, buttonGroup);
      fragment.append(row);
    }

    container.append(fragment);
  }

  globalThis.PopupRender = {
    renderEmailList,
    renderStatus
  };
})();
