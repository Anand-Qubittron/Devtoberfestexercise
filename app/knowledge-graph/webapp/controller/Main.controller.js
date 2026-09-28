sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/Text"
], function (Controller, JSONModel, Column, ColumnListItem, Text) {
  "use strict";

  // colour and icon per kind of entity in the graph
  var KINDS = {
    supplier: ["#0070f2", "sap-icon://supplier"],
    material: ["#188918", "sap-icon://product"],
    row: ["#5d36ff", "sap-icon://document-text"],
    upload: ["#1b90ff", "sap-icon://excel-attachment"],
    user: ["#a100c2", "sap-icon://person-placeholder"],
    process: ["#e76500", "sap-icon://process"],
    "purchase-request": ["#256f3a", "sap-icon://sales-order"],
    lock: ["#aa0808", "sap-icon://locked"],
    status: ["#8c4d00", "sap-icon://status-in-process"],
    session: ["#0057d2", "sap-icon://learning-assistant"],
    concept: ["#7800a4", "sap-icon://lightbulb"],
    app: ["#046c7c", "sap-icon://product"],
    file: ["#475e75", "sap-icon://source-code"],
    country: ["#475e75", "sap-icon://world"],
    value: ["#556b82", "sap-icon://tag"]
  };

  // light background in the kind's colour: #0070f2 → rgba(0,112,242,0.12)
  function tint(hex) {
    var n = parseInt(hex.slice(1), 16);
    return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + ",0.12)";
  }

  return Controller.extend("pc.knowledgegraph.controller.Main", {
    onInit: function () {
      this._base = this.getOwnerComponent().getManifestEntry("/sap.app/dataSources/kg/uri");
      this._view = new JSONModel({ question: "", suggestions: [], rows: [], reasons: [], tab: "answer", hasResult: false });
      this._graph = new JSONModel({
        nodes: [], lines: [],
        statuses: Object.keys(KINDS).map(function (k) { return { key: k, color: KINDS[k][0], background: tint(KINDS[k][0]) }; })
      });
      this.getView().setModel(this._view, "view");
      this.getView().setModel(this._graph, "graph");

      this._get("questions()").then(function (r) { this._view.setProperty("/suggestions", r.value); }.bind(this));
      this._get("stats()").then(function (r) {
        this._view.setProperty("/statsText", r.triples + " triples about " + r.subjects + " entities — generated live from the app data");
      }.bind(this));
    },

    onSuggestion: function (e) {
      this._view.setProperty("/question", e.getSource().getText());
      this.onAsk();
    },

    onAsk: function () {
      var question = (this._view.getProperty("/question") || "").trim();
      if (!question) return;
      this._post("ask", { question: question }).then(this._show.bind(this));
    },

    onRunSparql: function () {
      this._post("sparql", { query: this._view.getProperty("/sparql") }).then(function (result) {
        this._show(result);
        this._view.setProperty("/message", "Your SPARQL query: " + result.summary);
      }.bind(this));
    },

    _show: function (r) {
      var v = this._view;
      if (!r.understood) {
        v.setProperty("/message", r.message);
        v.setProperty("/messageType", "Warning");
        v.setProperty("/hasResult", false);
        return;
      }
      v.setProperty("/message", (r.interpretedAs ? "Understood as: “" + r.interpretedAs + "” — " : "") + r.summary);
      v.setProperty("/messageType", r.rows.length ? "Success" : "Information");
      v.setProperty("/sparql", r.sparql);
      v.setProperty("/rows", r.rows);
      v.setProperty("/reasons", (r.reasons || []).filter(function (steps) { return steps.length; })
        .map(function (steps, i) { return { no: i + 1, steps: steps }; }));
      v.setProperty("/graph", r.graph);
      v.setProperty("/hasResult", true);
      this._buildTable(r.columns);

      this._graph.setProperty("/nodes", r.graph.nodes.map(function (n) {
        var kind = KINDS[n.group] ? n.group : "value";
        return { key: n.key, title: n.title, group: kind, icon: KINDS[kind][1] };
      }));
      this._graph.setProperty("/lines", r.graph.lines);
    },

    _buildTable: function (columns) {
      var table = this.byId("answer");
      table.unbindItems();
      table.removeAllColumns();
      columns.forEach(function (c) {
        table.addColumn(new Column({ header: new Text({ text: this._title(c) }) }));
      }.bind(this));
      table.bindItems({
        path: "view>/rows",
        template: new ColumnListItem({
          cells: columns.map(function (c) { return new Text({ text: "{view>" + c + "}" }); })
        })
      });
    },

    // rowLabel → Row, supplierLabel → Supplier, prLabel → Purchase Request
    _title: function (name) {
      var n = name.replace(/Label$/, "");
      if (n === "pr") return "Purchase Request";
      return n.charAt(0).toUpperCase() + n.slice(1).replace(/([A-Z])/g, " $1");
    },

    _get: function (path) {
      return fetch(this._base + path, { headers: { accept: "application/json" } }).then(this._json);
    },

    _post: function (action, body) {
      this.getView().setBusy(true);
      return fetch(this._base + action, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
      }).then(this._json).then(function (r) { return JSON.parse(r.value); })
        .catch(function (e) {
          this._view.setProperty("/message", e.message);
          this._view.setProperty("/messageType", "Error");
          throw e;
        }.bind(this))
        .finally(function () { this.getView().setBusy(false); }.bind(this));
    },

    _json: function (res) {
      return res.json().then(function (body) {
        if (!res.ok) throw new Error(body.error ? body.error.message : res.statusText);
        return body;
      });
    }
  });
});
