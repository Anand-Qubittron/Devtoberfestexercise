@path: 'knowledge-graph'
@requires: 'authenticated-user'
service KnowledgeGraphService {
  type Question { id : String; text : String; }
  type Stats    { triples : Integer; subjects : Integer; }

  /** The business questions the graph can answer (offline natural language) */
  function questions() returns array of Question;
  function stats()     returns Stats;

  /** Question in plain language → SPARQL → answer + chain of reasoning (JSON) */
  action ask(question : LargeString)   returns LargeString;
  /** Free SELECT / ASK query (JSON) */
  action sparql(query : LargeString)   returns LargeString;
}
