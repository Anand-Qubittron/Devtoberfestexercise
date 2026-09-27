sap.ui.define(["sap/ui/core/mvc/ControllerExtension"], function (ControllerExtension) {
  "use strict";
  // Refreshes the page every few seconds, so background processing is visible live.
  return ControllerExtension.extend("pc.uploads.ext.AutoRefresh", {
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
      // never refresh while the user is editing a draft
      var ctx = view.getBindingContext();
      if (!ctx || ctx.getProperty("IsActiveEntity") !== true) return;
      this.base.getExtensionAPI().refresh();
    }
  });
});
