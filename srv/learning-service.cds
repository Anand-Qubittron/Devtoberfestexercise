using { learning } from '../db/learning';

@path: 'learning'
@requires: 'authenticated-user'
service LearningService {
  @readonly entity Sessions as projection on learning.Sessions;
  @readonly entity Concepts as projection on learning.Concepts;
}
