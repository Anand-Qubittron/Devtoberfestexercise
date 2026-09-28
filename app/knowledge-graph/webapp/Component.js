sap.ui.define(["sap/ui/core/UIComponent"], function (UIComponent) {
  "use strict";
  return UIComponent.extend("pc.knowledgegraph.Component", {
    metadata: {
      manifest: "json",
      // create the root view asynchronously, as the launchpad runs in async mode
      interfaces: ["sap.ui.core.IAsyncContentCreation"]
    }
  });
});
