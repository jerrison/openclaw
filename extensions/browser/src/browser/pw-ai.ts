/** Playwright-backed browser helpers loaded as one optional runtime module. */
export {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  createObservedDialogAbortSignalForPage,
  createPageViaPlaywright,
  ensurePageState,
  focusPageByTargetIdViaPlaywright,
  forceDisconnectPlaywrightForTarget,
  getObservedBrowserStateForPage,
  getObservedBrowserStateViaPlaywright,
  getDocumentIdentitiesViaPlaywright,
  getPageForTargetId,
  hasCachedPlaywrightBrowserConnection,
  isBrowserObservedDialogBlockedError,
  listPagesViaPlaywright,
  markObservedDialogsHandledRemotelyForPage,
  refLocator,
  respondToObservedDialogOnPage,
  retirePlaywrightBrowserConnectionExact,
} from "./pw-session.js";
export {
  getConsoleMessagesViaPlaywright,
  getNetworkRequestsViaPlaywright,
  getPageErrorsViaPlaywright,
  getPageTextViaPlaywright,
} from "./pw-tools-core.activity.js";
export {
  armDialogViaPlaywright,
  armFileUploadViaPlaywright,
  downloadCurrentDocumentViaPlaywright,
  downloadViaPlaywright,
  uploadViaPlaywright,
  waitForDownloadViaPlaywright,
} from "./pw-tools-core.downloads.js";
export {
  batchViaPlaywright,
  clickViaPlaywright,
  dragViaPlaywright,
  evaluateViaPlaywright,
  executeActViaPlaywright,
  fillFormViaPlaywright,
  highlightViaPlaywright,
  hoverViaPlaywright,
  pressKeyViaPlaywright,
  screenshotWithLabelsViaPlaywright,
  scrollIntoViewViaPlaywright,
  selectOptionViaPlaywright,
  setInputFilesViaPlaywright,
  takeScreenshotViaPlaywright,
  typeViaPlaywright,
  waitForViaPlaywright,
} from "./pw-tools-core.interactions.js";
export { responseBodyViaPlaywright } from "./pw-tools-core.responses.js";
export {
  closePageViaPlaywright,
  navigateViaPlaywright,
  pdfViaPlaywright,
  resizeViewportViaPlaywright,
  snapshotAriaViaPlaywright,
  snapshotRoleViaPlaywright,
  storeSnapshotRefsViaPlaywright,
} from "./pw-tools-core.snapshot.js";
export {
  emulateMediaViaPlaywright,
  setDeviceViaPlaywright,
  setExtraHTTPHeadersViaPlaywright,
  setGeolocationViaPlaywright,
  setHttpCredentialsViaPlaywright,
  setLocaleViaPlaywright,
  setOfflineViaPlaywright,
  setTimezoneViaPlaywright,
} from "./pw-tools-core.state.js";
export {
  cookiesClearViaPlaywright,
  cookiesGetViaPlaywright,
  cookiesSetManyViaPlaywright,
  cookiesSetViaPlaywright,
  storageClearViaPlaywright,
  storageGetViaPlaywright,
  storageSetViaPlaywright,
} from "./pw-tools-core.storage.js";
export { traceStartViaPlaywright, traceStopViaPlaywright } from "./pw-tools-core.trace.js";
