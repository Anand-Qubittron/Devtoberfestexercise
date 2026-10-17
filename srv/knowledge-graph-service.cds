@path: 'knowledge-graph'
@requires: 'authenticated-user'
service KnowledgeGraphService {
  type Question { id : String; text : String; }
  type Stats    { triples : Integer; subjects : Integer; }

  /** Featured questions (hand-tuned) and examples of free questions */
  function questions() returns array of Question;
  function examples()  returns array of String;
  function stats()     returns Stats;

  /** Named graphs (sources) and which of them the current user may see (JSON) */
  function profile()   returns LargeString;
  /** SHACL validation report for the user's graph (JSON) */
  function quality()   returns LargeString;
  /** The user's graph as N-Quads */
  function rdf()       returns LargeString;

  /** Question in plain language → SPARQL → answer + chain of reasoning + sources (JSON) */
  action ask(question : LargeString)   returns LargeString;
  /** Free SELECT / ASK query (JSON) */
  action sparql(query : LargeString)   returns LargeString;
  /** Everything directly connected to one entity (JSON) */
  action explore(iri : String)         returns LargeString;
}
