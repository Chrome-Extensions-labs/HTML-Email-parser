(() => {
  function createState() {
    return {
      emails: [],
      loading: false,
      activeTabId: null
    };
  }

  function setEmails(state, emails) {
    state.emails = globalThis.EmailParserUtils.sortByBusinessPriority(emails || []);
  }

  function setLoading(state, loading) {
    state.loading = Boolean(loading);
  }

  function setActiveTabId(state, tabId) {
    state.activeTabId = tabId ?? null;
  }

  globalThis.PopupState = {
    createState,
    setActiveTabId,
    setEmails,
    setLoading
  };
})();
