namespace demo;

using { cuid, managed } from '@sap/cds/common';
using { pc } from './process-center';

entity Suppliers : cuid, managed {
  supplierNo : String(10) @mandatory;
  name       : String(100) @mandatory;
  country    : String(3);
  blocked    : Boolean default false;
  blockedCriticality : Integer = (blocked = true ? 1 : 3);
  materials  : Association to many Materials on materials.supplier = $self;
}

entity Materials : cuid, managed {
  materialNo  : String(20) @mandatory;
  description : String(100);
  price       : Decimal(10, 2);
  supplier    : Association to Suppliers @mandatory;
}

/** An Excel upload. Activating its draft turns every row into a process instance. */
entity UploadBatches : cuid, managed {
  name     : String(100) @mandatory;
  file     : LargeBinary @Core.MediaType: fileType @Core.ContentDisposition.Filename: fileName;
  fileName : String(255);
  fileType : String(100) @Core.IsMediaType;
  items    : Composition of many UploadItems on items.batch = $self;

  // filled on read from the process instances of the items
  virtual total     : Integer;
  virtual completed : Integer;
  virtual inProcess : Integer;
  virtual parked    : Integer;
  virtual failed    : Integer;
}

entity UploadItems : cuid {
  batch      : Association to UploadBatches;
  rowNo      : Integer;
  materialNo : String(20);
  quantity   : Integer;
  process    : Association to pc.ProcessInstances;
}

/** Created by the process. sourceItem is unique, so a resumed process can never create a duplicate. */
@assert.unique: { sourceItem: [sourceItem] }
entity PurchaseRequests : cuid, managed {
  prNo       : String(12);
  material   : Association to Materials;
  supplier   : Association to Suppliers;
  quantity   : Integer;
  amount     : Decimal(12, 2);
  sourceItem : UUID;
}

entity Notifications : cuid, managed {
  recipient : String(100);
  text      : String(500);
}
