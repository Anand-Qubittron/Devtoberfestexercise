using { demo } from '../db/demo';
using { pc } from '../db/process-center';

@path: 'demo'
@requires: 'authenticated-user'
service DemoService {
  @odata.draft.enabled
  @cds.redirection.target
  entity Suppliers        as projection on demo.Suppliers;

  @odata.draft.enabled
  entity Materials        as projection on demo.Materials;

  @odata.draft.enabled
  entity UploadBatches    as projection on demo.UploadBatches;
  entity UploadItems      as projection on demo.UploadItems;

  @readonly entity PurchaseRequests as projection on demo.PurchaseRequests;
  @readonly entity Notifications    as projection on demo.Notifications;
  @readonly entity SupplierVH       as projection on demo.Suppliers { ID, supplierNo, name, country, blocked };
  @readonly entity ProcessInstances as projection on pc.ProcessInstances excluding { context };
}
