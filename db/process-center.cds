namespace pc;

using { cuid, managed } from '@sap/cds/common';

/**
 * Lifecycle of one process instance (one business object going through a process):
 *
 *   Ready ──► Running ──► Completed
 *                │
 *                ├─ TechnicalError ──► Retrying ──(auto, backoff)──► Running ...
 *                │                        └─ max attempts reached ──► Failed
 *                └─ BusinessError  ──► Parked  ──(user fixes data / Resume)──► Ready
 *
 *   Any non-final state ──(Cancel)──► Cancelled
 */
type Status : String(12) enum {
  Ready; Running; Retrying; Parked; Failed; Completed; Cancelled;
}

type ErrorKind : String(10) enum { Business; Technical; }

entity ProcessInstances : cuid, managed {
  process         : String(60);            // process definition name
  objectType      : String(40);            // business object the process runs for
  objectKey       : String(100);
  objectText      : String(255);           // human readable label for monitors
  status          : Status default 'Ready';
  stepNo          : Integer default 0;     // index of the step to run next (0-based)
  totalSteps      : Integer;
  currentStep     : String(60);
  attempts        : Integer default 0;     // attempts of the current step
  nextRunAt       : Timestamp;
  errorKind       : ErrorKind;
  lastError       : String(1000);
  waitingForType  : String(40);            // a Parked instance resumes automatically
  waitingForKey   : String(100);           // once this object is saved
  context         : LargeString;           // JSON data handed from step to step
  finishedAt      : Timestamp;
  steps           : Composition of many StepExecutions on steps.instance = $self;

  statusCriticality : Integer = (
    case status
      when 'Completed' then 3
      when 'Parked'    then 2
      when 'Retrying'  then 2
      when 'Failed'    then 1
      when 'Cancelled' then 0
      else 5
    end
  );
  progress : Integer = (
    case when totalSteps > 0 then (stepNo * 100) / totalSteps else 0 end
  );
}

/** The living log: one row per executed step attempt */
entity StepExecutions : cuid {
  instance    : Association to ProcessInstances;
  stepNo      : Integer;
  step        : String(60);
  attempt     : Integer;
  status      : String(12) enum { Succeeded; Failed; Skipped; };
  errorKind   : ErrorKind;
  message     : String(1000);
  startedAt   : Timestamp;
  finishedAt  : Timestamp;
  durationMs  : Integer;

  statusCriticality : Integer = (
    case status when 'Succeeded' then 3 when 'Skipped' then 2 else 1 end
  );
}

/**
 * Object locks spanning several business objects (cross-object scope).
 *  S = shared   (a process reads the object; many processes may share)
 *  X = exclusive (a user edits the object in a draft, or a process owns it)
 */
entity ObjectLocks : cuid {
  objectType : String(40);
  objectKey  : String(100);
  objectText : String(255);
  mode       : String(1) enum { S; X; };
  owner      : String(120);                // 'process:<id>' or 'draft:<user>'
  ownerText  : String(255);
  createdAt  : Timestamp;
  expiresAt  : Timestamp;                  // draft locks expire like draft locks do
}

/** Switches to make the demo fail on purpose */
entity DemoSettings {
  key ID                : Integer;
      technicalErrorRate : Integer default 20;  // % of steps that fail once (transient)
      stepDelayMs        : Integer default 300; // slows steps down so progress is visible
      retryDelaySeconds  : Integer default 5;   // base backoff; minutes in real life
}
