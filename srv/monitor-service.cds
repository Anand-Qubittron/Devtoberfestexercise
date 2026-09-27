using { pc } from '../db/process-center';

@path: 'process-monitor'
@requires: 'authenticated-user'
service ProcessMonitorService {

  @readonly
  entity ProcessInstances as projection on pc.ProcessInstances {
    *,
    // drive which actions are enabled in the UI
    (status in ('Parked', 'Failed', 'Retrying') ? true : false) as canResume : Boolean,
    (status in ('Ready', 'Parked', 'Failed', 'Retrying') ? true : false) as canCancel : Boolean,
    (status in ('Parked', 'Failed') ? true : false) as canSkip : Boolean
  } actions {
    @(Common.SideEffects: { TargetEntities: ['in', 'in/steps'] })
    action resume() returns ProcessInstances;
    @(Common.SideEffects: { TargetEntities: ['in', 'in/steps'] })
    action skipStep() returns ProcessInstances;
    @(Common.SideEffects: { TargetEntities: ['in', 'in/steps'] })
    action cancel() returns ProcessInstances;
  };

  @readonly entity StepExecutions as projection on pc.StepExecutions;
  @readonly entity ObjectLocks    as projection on pc.ObjectLocks;
  @readonly entity DemoSettings   as projection on pc.DemoSettings;

  /** Chaos switches for the demo */
  action configureDemo(
    @title: 'Transient error rate (%)' technicalErrorRate : Integer,
    @title: 'Step delay (ms)'          stepDelayMs        : Integer,
    @title: 'Retry delay (s)'          retryDelaySeconds  : Integer
  ) returns DemoSettings;
}
