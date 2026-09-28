using ProcessMonitorService as M from '../srv/monitor-service';
using DemoService as D from '../srv/demo-service';

//
// ─── Process Monitor ──────────────────────────────────────────────────────────
//
annotate M.ProcessInstances with @(
  UI.HeaderInfo: {
    TypeName: 'Process', TypeNamePlural: 'Processes',
    Title: { Value: objectText }, Description: { Value: process }
  },
  UI.SelectionFields: [ status, process, errorKind, currentStep ],
  UI.PresentationVariant: { SortOrder: [{ Property: modifiedAt, Descending: true }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.resume',   Label: 'Resume' },
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.skipStep', Label: 'Skip Step' },
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.cancel',   Label: 'Cancel' },
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.EntityContainer/configureDemo', Label: 'Demo Settings' },
    { Value: objectText,  Label: 'Object' },
    { Value: status,      Label: 'Status', Criticality: statusCriticality },
    { Value: currentStep, Label: 'Current Step' },
    { $Type: 'UI.DataFieldForAnnotation', Target: '@UI.DataPoint#progress', Label: 'Progress' },
    { Value: attempts,    Label: 'Attempts' },
    { Value: lastError,   Label: 'Last Message' },
    { Value: nextRunAt,   Label: 'Next Run' },
    { Value: modifiedAt,  Label: 'Last Change' }
  ],
  UI.DataPoint #progress: { Value: progress, TargetValue: 100, Visualization: #Progress, Criticality: statusCriticality, Title: 'Progress' },
  UI.DataPoint #status:   { Value: status, Criticality: statusCriticality, Title: 'Status' },
  UI.DataPoint #attempts: { Value: attempts, Title: 'Attempts of current step' },

  UI.SelectionVariant #attention: { Text: 'Needs Attention', SelectOptions: [{ PropertyName: status, Ranges: [
    { Sign: #I, Option: #EQ, Low: 'Parked' }, { Sign: #I, Option: #EQ, Low: 'Failed' } ] }] },
  UI.SelectionVariant #running: { Text: 'In Process', SelectOptions: [{ PropertyName: status, Ranges: [
    { Sign: #I, Option: #EQ, Low: 'Ready' }, { Sign: #I, Option: #EQ, Low: 'Running' }, { Sign: #I, Option: #EQ, Low: 'Retrying' } ] }] },
  UI.SelectionVariant #completed: { Text: 'Completed', SelectOptions: [{ PropertyName: status, Ranges: [
    { Sign: #I, Option: #EQ, Low: 'Completed' } ] }] },
  UI.SelectionVariant #all: { Text: 'All', SelectOptions: [{ PropertyName: status, Ranges: [
    { Sign: #I, Option: #NE, Low: '' } ] }] },

  UI.Identification: [
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.resume',   Label: 'Resume' },
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.skipStep', Label: 'Skip Step' },
    { $Type: 'UI.DataFieldForAction', Action: 'ProcessMonitorService.cancel',   Label: 'Cancel' }
  ],
  UI.HeaderFacets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#status' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#progress' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#attempts' }
  ],
  UI.FieldGroup #problem: { Data: [
    { Value: errorKind,      Label: 'Error Type' },
    { Value: lastError,      Label: 'Message' },
    { Value: waitingForType, Label: 'Resumes automatically when this is saved' },
    { Value: waitingForKey,  Label: 'Key' },
    { Value: nextRunAt,      Label: 'Next Automatic Retry' }
  ]},
  UI.FieldGroup #general: { Data: [
    { Value: process,     Label: 'Process' },
    { Value: currentStep, Label: 'Current Step' },
    { Value: objectType,  Label: 'Object Type' },
    { Value: objectKey,   Label: 'Object Key' },
    { Value: createdAt,   Label: 'Started' },
    { Value: createdBy,   Label: 'Started By' },
    { Value: finishedAt,  Label: 'Finished' }
  ]},
  UI.FieldGroup #data: { Data: [ { Value: context, Label: 'Data passed between steps (JSON)' } ] },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Problem',   Target: '@UI.FieldGroup#problem', ![@UI.Hidden]: (errorKind is null) },
    { $Type: 'UI.ReferenceFacet', Label: 'Step Log',  Target: 'steps/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', Label: 'General',   Target: '@UI.FieldGroup#general' },
    { $Type: 'UI.ReferenceFacet', Label: 'Process Data', Target: '@UI.FieldGroup#data' }
  ]
) {
  status     @title: 'Status';
  process    @title: 'Process';
  errorKind  @title: 'Error Type';
  currentStep @title: 'Current Step';
  context    @UI.MultiLineText;
  lastError  @UI.MultiLineText;
};

annotate M.ProcessInstances actions {
  resume   @Core.OperationAvailable: { $edmJson: { $Path: 'in/canResume' } };
  skipStep @Core.OperationAvailable: { $edmJson: { $Path: 'in/canSkip' } };
  cancel   @Core.OperationAvailable: { $edmJson: { $Path: 'in/canCancel' } };
};

annotate M.StepExecutions with @(
  UI.PresentationVariant: { SortOrder: [{ Property: startedAt, Descending: true }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { Value: startedAt,  Label: 'Started' },
    { Value: step,       Label: 'Step' },
    { Value: attempt,    Label: 'Attempt' },
    { Value: status,     Label: 'Result', Criticality: statusCriticality },
    { Value: errorKind,  Label: 'Error Type' },
    { Value: message,    Label: 'Log' },
    { Value: durationMs, Label: 'Duration (ms)' }
  ]
);

annotate M.ObjectLocks with @(
  UI.HeaderInfo: { TypeName: 'Lock', TypeNamePlural: 'Object Locks', Title: { Value: objectText } },
  UI.SelectionFields: [ objectType, mode ],
  UI.LineItem: [
    { Value: objectText, Label: 'Object' },
    { Value: objectType, Label: 'Type' },
    { Value: mode,       Label: 'Mode (S shared / X exclusive)' },
    { Value: ownerText,  Label: 'Held By' },
    { Value: createdAt,  Label: 'Since' },
    { Value: expiresAt,  Label: 'Expires' }
  ]
) { objectType @title: 'Type'; mode @title: 'Mode'; };

//
// ─── Demo business objects ───────────────────────────────────────────────────
//
annotate D.Suppliers with @(
  UI.HeaderInfo: { TypeName: 'Supplier', TypeNamePlural: 'Suppliers', Title: { Value: name }, Description: { Value: supplierNo } },
  UI.SelectionFields: [ supplierNo, country, blocked ],
  UI.LineItem: [
    { Value: supplierNo }, { Value: name }, { Value: country },
    { Value: blocked, Criticality: blockedCriticality }
  ],
  UI.FieldGroup #main: { Data: [ { Value: supplierNo }, { Value: name }, { Value: country }, { Value: blocked } ] },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Supplier', Target: '@UI.FieldGroup#main' },
    { $Type: 'UI.ReferenceFacet', Label: 'Materials (locked while you edit this supplier)', Target: 'materials/@UI.LineItem' }
  ]
) {
  supplierNo @title: 'Supplier';
  name       @title: 'Name';
  country    @title: 'Country';
  blocked    @title: 'Blocked for Purchasing';
  ID         @UI.Hidden @Common.Text: name @Common.TextArrangement: #TextOnly;
};

annotate D.Materials with @(
  UI.HeaderInfo: { TypeName: 'Material', TypeNamePlural: 'Materials', Title: { Value: materialNo }, Description: { Value: description } },
  UI.SelectionFields: [ materialNo, supplier_ID ],
  UI.LineItem: [ { Value: materialNo }, { Value: description }, { Value: price }, { Value: supplier_ID } ],
  UI.FieldGroup #main: { Data: [ { Value: materialNo }, { Value: description }, { Value: price }, { Value: supplier_ID } ] },
  UI.Facets: [ { $Type: 'UI.ReferenceFacet', Label: 'Material', Target: '@UI.FieldGroup#main' } ]
) {
  materialNo  @title: 'Material';
  description @title: 'Description';
  price       @title: 'Price (EUR)';
  supplier    @title: 'Supplier' @Common.Text: supplier.name @Common.TextArrangement: #TextOnly
    @Common.ValueList: { CollectionPath: 'SupplierVH', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: supplier_ID, ValueListProperty: 'ID' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'supplierNo' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'blocked' } ] };
};

annotate D.UploadBatches with @(
  UI.HeaderInfo: { TypeName: 'Excel Upload', TypeNamePlural: 'Excel Uploads', Title: { Value: name }, Description: { Value: fileName } },
  UI.SelectionFields: [ name, createdBy ],
  UI.PresentationVariant: { SortOrder: [{ Property: createdAt, Descending: true }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { Value: name }, { Value: fileName }, { Value: total },
    { Value: completed, Criticality: #Positive }, { Value: inProcess }, { Value: parked, Criticality: #Critical }, { Value: failed, Criticality: #Negative },
    { Value: createdBy, Label: 'Uploaded By' }, { Value: createdAt, Label: 'Uploaded On' }
  ],
  UI.DataPoint #total:     { Value: total,     Title: 'Rows' },
  UI.DataPoint #completed: { Value: completed, Title: 'Completed', Criticality: #Positive },
  UI.DataPoint #inProcess: { Value: inProcess, Title: 'In Process', Criticality: #Information },
  UI.DataPoint #parked:    { Value: parked,    Title: 'Needs Attention', Criticality: #Critical },
  UI.DataPoint #failed:    { Value: failed,    Title: 'Failed', Criticality: #Negative },
  UI.HeaderFacets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#total' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#completed' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#inProcess' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#parked' },
    { $Type: 'UI.ReferenceFacet', Target: '@UI.DataPoint#failed' }
  ],
  UI.FieldGroup #main: { Data: [ { Value: name }, { Value: file, Label: 'Excel File (.xlsx: columns Material, Quantity)' } ] },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', Label: 'Upload', Target: '@UI.FieldGroup#main' },
    { $Type: 'UI.ReferenceFacet', Label: 'Rows', Target: 'items/@UI.LineItem' }
  ]
) {
  name      @title: 'Name';
  fileName  @title: 'File';
  file      @Core.AcceptableMediaTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'];
  total     @title: 'Rows';
  completed @title: 'Completed';
  inProcess @title: 'In Process';
  parked    @title: 'Needs Attention';
  failed    @title: 'Failed';
};

annotate D.UploadItems with @(
  UI.HeaderInfo: { TypeName: 'Row', TypeNamePlural: 'Rows', Title: { Value: materialNo } },
  UI.PresentationVariant: { SortOrder: [{ Property: rowNo }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { Value: rowNo }, { Value: materialNo }, { Value: quantity },
    { Value: process.status,      Label: 'Status', Criticality: process.statusCriticality },
    { Value: process.currentStep, Label: 'Step' },
    { Value: process.lastError,   Label: 'Message' }
  ]
) {
  rowNo      @title: 'Row' @readonly;
  materialNo @title: 'Material';
  quantity   @title: 'Quantity';
  process    @readonly;
};

annotate D.PurchaseRequests with @(
  UI.HeaderInfo: { TypeName: 'Purchase Request', TypeNamePlural: 'Purchase Requests', Title: { Value: prNo } },
  UI.SelectionFields: [ prNo, supplier_ID, material_ID ],
  UI.PresentationVariant: { SortOrder: [{ Property: prNo, Descending: true }], Visualizations: ['@UI.LineItem'] },
  UI.LineItem: [
    { Value: prNo }, { Value: material.materialNo, Label: 'Material' }, { Value: material.description, Label: 'Description' },
    { Value: supplier.name, Label: 'Supplier' }, { Value: quantity }, { Value: amount }, { Value: createdAt, Label: 'Created On' }
  ]
) {
  prNo     @title: 'Purchase Request';
  quantity @title: 'Quantity';
  amount   @title: 'Amount (EUR)';
  supplier @title: 'Supplier' @Common.Text: supplier.name @Common.TextArrangement: #TextOnly
    @Common.ValueList: { CollectionPath: 'SupplierVH', Parameters: [
    { $Type: 'Common.ValueListParameterInOut', LocalDataProperty: supplier_ID, ValueListProperty: 'ID' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'supplierNo' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'name' },
    { $Type: 'Common.ValueListParameterDisplayOnly', ValueListProperty: 'blocked' } ] };
  material @title: 'Material' @Common.Text: material.materialNo @Common.TextArrangement: #TextOnly;
};

annotate D.SupplierVH with {
  ID         @UI.Hidden;
  supplierNo @title: 'Supplier';
  name       @title: 'Name';
  blocked    @title: 'Blocked';
};
