sap.ui.define(["sap/ui/core/mvc/ControllerExtension"], function (ControllerExtension) {
  "use strict";
  // Refreshes the page every few seconds, so background processing is visible live.
  return ControllerExtension.extend("pc.objectlocks.ext.AutoRefresh", {
    override: {
      onInit: function () {
        this._timer = setInterval(this._refresh.bind(this), 3000);
      },
      onExit: function () {
        clearInterval(this._timer);
      }
    },
    _refresh: function () {
      var view = this.base.getView();
      if (document.hidden || !view.getDomRef() || document.querySelector(".sapMDialog")) return;
      // keep the user's selection for bulk actions
      var selected = view.findAggregatedObjects(true, function (c) { return c.isA("sap.ui.mdc.Table"); })
        .some(function (t) { return t.getSelectedContexts().length > 0; });
      if (selected) return;
      this.base.getExtensionAPI().refresh();
    }
  });
});
