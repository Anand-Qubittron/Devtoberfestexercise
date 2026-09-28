namespace learning;

/** A Devtoberfest session I attended — and what I made of it */
entity Sessions {
  key ID        : String(40);
  date          : Date;
  title         : String(200);
  track         : String(40);
  summary       : String(2000);
  takeaways     : String(4000);   // one per line
  whatIBuilt    : String(4000);
  concepts      : Composition of many Concepts on concepts.session = $self;
}

/** A concept from a session and where it is implemented in this project */
entity Concepts {
  key ID          : String(60);
      session     : Association to Sessions;
      name        : String(120);
      description : String(1000);
      implementation : String(1000);  // how it is realised here
      appTitle    : String(60);       // where to see it
      appUrl      : String(200);      // launchpad intent, e.g. #ProcessInstance-monitor
      sourceFile  : String(200);
}
