// PIE — reference data: skill ontology, learning resource registry, personas, requisitions.
// All persona/requisition data is ILLUSTRATIVE and clearly labelled as such in the UI.

/* ------------------------------------------------------------------ ONTOLOGY */
// Canonical skills. `aliases` remove the vocabulary-mismatch failure mode (F4).
// `demand` is an illustrative market-demand index (0-1) used by Market Intelligence.
export const ONTOLOGY = [
  { id: 'python',      name: 'Python',                 category: 'Programming',   demand: 0.95, aliases: ['python', 'python3', 'py', 'pandas', 'numpy'] },
  { id: 'java',        name: 'Java',                   category: 'Programming',   demand: 0.82, aliases: ['java', 'jdk', 'j2ee', 'core java'] },
  { id: 'javascript',  name: 'JavaScript',             category: 'Programming',   demand: 0.90, aliases: ['javascript', 'js', 'es6', 'ecmascript', 'node', 'nodejs', 'node.js'] },
  { id: 'sql',         name: 'SQL',                    category: 'Data',          demand: 0.93, aliases: ['sql', 'postgres', 'postgresql', 'mysql', 'queries', 'rdbms'] },
  { id: 'selenium',    name: 'Selenium / UI Automation',category: 'Quality',      demand: 0.71, aliases: ['selenium', 'webdriver', 'ui automation', 'browser automation'] },
  { id: 'testautomation', name: 'Test Automation',     category: 'Quality',       demand: 0.86, aliases: ['test automation', 'automation testing', 'qa automation', 'testng', 'junit', 'pytest', 'regression suite'] },
  { id: 'apitesting',  name: 'API Testing',            category: 'Quality',       demand: 0.78, aliases: ['api testing', 'rest assured', 'postman', 'contract testing', 'api test'] },
  { id: 'cicd',        name: 'CI/CD',                  category: 'Engineering',   demand: 0.88, aliases: ['ci/cd', 'cicd', 'jenkins', 'github actions', 'continuous integration', 'pipeline', 'pipelines'] },
  { id: 'dataanalysis',name: 'Data Analysis',          category: 'Data',          demand: 0.91, aliases: ['data analysis', 'data analytics', 'analysis', 'eda', 'exploratory data analysis', 'matplotlib', 'visualisation', 'visualization'] },
  { id: 'dataquality', name: 'Data Quality Engineering',category: 'Data',         demand: 0.84, aliases: ['data quality', 'data validation', 'data testing', 'great expectations', 'data reconciliation'] },
  { id: 'docker',      name: 'Docker / Containers',    category: 'Engineering',   demand: 0.85, aliases: ['docker', 'container', 'containers', 'containerisation', 'containerization'] },
  { id: 'react',       name: 'React',                  category: 'Frontend',      demand: 0.89, aliases: ['react', 'reactjs', 'react.js'] },
  { id: 'mongodb',     name: 'MongoDB',                category: 'Data',          demand: 0.66, aliases: ['mongodb', 'mongo', 'mongoose'] },
  { id: 'express',     name: 'Express / REST APIs',    category: 'Backend',       demand: 0.80, aliases: ['express', 'expressjs', 'rest api', 'rest apis', 'restful'] },
  { id: 'git',         name: 'Git & Version Control',  category: 'Engineering',   demand: 0.92, aliases: ['git', 'github', 'version control', 'branching'] },
  { id: 'cloud',       name: 'Cloud Fundamentals',     category: 'Engineering',   demand: 0.87, aliases: ['cloud', 'aws', 'azure', 'gcp', 'btp', 'cloud foundry'] },
  { id: 'communication', name: 'Written Communication',category: 'Professional',  demand: 0.70, aliases: ['documentation', 'readme', 'technical writing', 'stakeholder communication'] },
];

export const SKILL_BY_ID = Object.fromEntries(ONTOLOGY.map(s => [s.id, s]));

/* --------------------------------------------------- LEARNING RESOURCE REGISTRY */
// LearningResource abstraction: PIE is not hard-coded to SAP. SAP is a first-class,
// VERIFIED provider. No SAP Learning Hub API is claimed — routing is link-based.
export const LEARNING_PROVIDERS = {
  SAP_LEARNING_HUB: {
    id: 'SAP_LEARNING_HUB',
    name: 'SAP Learning Hub, student edition',
    source: 'Official SAP',
    verification_status: 'Verified',
    completion_verification: 'NOT_AVAILABLE',
    base_url: 'https://learning.sap.com/free-student-edition',
    note: 'Link/resource-redirection integration. PIE does not own or control the candidate’s SAP Universal ID or Learning Hub account, and does not claim automated enrolment or completion data.',
  },
  PIE_PRACTICE: {
    id: 'PIE_PRACTICE',
    name: 'PIE Practice Task',
    source: 'PIE internal',
    verification_status: 'Verified',
    completion_verification: 'PIE_REASSESSMENT',
    base_url: null,
    note: 'Generated practice task; completion is verified by PIE reassessment, producing new skill evidence.',
  },
  OPEN_WEB: {
    id: 'OPEN_WEB',
    name: 'Open Learning Resource',
    source: 'Third party',
    verification_status: 'Unverified',
    completion_verification: 'CANDIDATE_DECLARED',
    base_url: null,
    note: 'Candidate-declared completion only; produces self-reported evidence at the lowest trust tier.',
  },
};

export const LEARNING_RESOURCES = [
  {
    resource_id: 'SAP-BTP-CAP-01', provider: 'SAP_LEARNING_HUB', skill: 'cloud',
    title: 'Develop extensions with CAP following the SAP BTP Developer’s Guide',
    difficulty: 'Intermediate', learning_type: 'Hands-on practice system', hours: 12,
    description: 'Hands-on SAP BTP practice: build CAP-based service extensions on Cloud Foundry.',
    external_url: 'https://learning.sap.com/free-student-edition', availability: 'Student edition',
  },
  {
    resource_id: 'SAP-HANA-01', provider: 'SAP_LEARNING_HUB', skill: 'sql',
    title: 'SAP HANA Cloud — Modeling & Provisioning Data',
    difficulty: 'Intermediate', learning_type: 'Hands-on practice system', hours: 10,
    description: 'Data modelling and provisioning on SAP HANA Cloud; strengthens applied SQL and data modelling.',
    external_url: 'https://learning.sap.com/free-student-edition', availability: 'Student edition',
  },
  {
    resource_id: 'SAP-GENAI-01', provider: 'SAP_LEARNING_HUB', skill: 'python',
    title: 'Solve business problems using prompts and LLMs in SAP Generative AI Hub',
    difficulty: 'Intermediate', learning_type: 'Hands-on practice system', hours: 8,
    description: 'Applied prompting and LLM orchestration in SAP Generative AI Hub, using Python-based tooling.',
    external_url: 'https://learning.sap.com/free-student-edition', availability: 'Student edition',
  },
  {
    resource_id: 'SAP-SAC-01', provider: 'SAP_LEARNING_HUB', skill: 'dataanalysis',
    title: 'Exploring SAP Analytics Cloud — Modeling, Data Transformation & Story Design',
    difficulty: 'Beginner', learning_type: 'Hands-on practice system', hours: 9,
    description: 'Build models, transform data and design analytical stories in SAP Analytics Cloud.',
    external_url: 'https://learning.sap.com/free-student-edition', availability: 'Student edition',
  },
  {
    resource_id: 'SAP-BDC-01', provider: 'SAP_LEARNING_HUB', skill: 'dataquality',
    title: 'AI-powered Visualizations and Augmented Analytics on Business Data (SAP BDC)',
    difficulty: 'Intermediate', learning_type: 'Hands-on practice system', hours: 7,
    description: 'Augmented analytics over business data; applied data-quality and validation thinking.',
    external_url: 'https://learning.sap.com/free-student-edition', availability: 'Student edition',
  },
  {
    resource_id: 'SAP-BUILD-01', provider: 'SAP_LEARNING_HUB', skill: 'cicd',
    title: 'SAP Build & SAP Business Application Studio — Sandbox',
    difficulty: 'Beginner', learning_type: 'Hands-on practice system', hours: 6,
    description: 'Application lifecycle and deployment workflow in SAP Build / Business Application Studio.',
    external_url: 'https://learning.sap.com/free-student-edition', availability: 'Student edition',
  },
  { resource_id: 'PIE-PR-DOCKER', provider: 'PIE_PRACTICE', skill: 'docker',
    title: 'Containerise your existing test suite', difficulty: 'Beginner',
    learning_type: 'Practice task', hours: 4,
    description: 'Write a Dockerfile for an existing automation suite, run it in a container, and push the image. Produces verifiable repository evidence.',
    external_url: null, availability: 'Always' },
  { resource_id: 'PIE-PR-DQ', provider: 'PIE_PRACTICE', skill: 'dataquality',
    title: 'Build a data-validation harness over a public dataset', difficulty: 'Intermediate',
    learning_type: 'Practice project', hours: 8,
    description: 'Define validation rules, detect violations, and report reconciliation results on a public dataset. Reassessed by PIE.',
    external_url: null, availability: 'Always' },
  { resource_id: 'PIE-PR-CICD', provider: 'PIE_PRACTICE', skill: 'cicd',
    title: 'Wire your test suite into GitHub Actions', difficulty: 'Beginner',
    learning_type: 'Practice task', hours: 3,
    description: 'Add a CI workflow that runs your suite on every push and publishes results. Produces API-derived evidence.',
    external_url: null, availability: 'Always' },
  { resource_id: 'PIE-PR-API', provider: 'PIE_PRACTICE', skill: 'apitesting',
    title: 'Contract-test a public REST API end to end', difficulty: 'Intermediate',
    learning_type: 'Practice task', hours: 5,
    description: 'Write request/response contract tests with schema assertions and negative cases against a public API. Scored by PIE reassessment.',
    external_url: null, availability: 'Always' },
  { resource_id: 'OPEN-DOCKER-01', provider: 'OPEN_WEB', skill: 'docker',
    title: 'Container fundamentals — open course', difficulty: 'Beginner',
    learning_type: 'Self-paced course', hours: 6,
    description: 'Images, layers, volumes and networking. Third-party resource; completion is candidate-declared only.',
    external_url: null, availability: 'Open' },
  { resource_id: 'PIE-PR-SQL', provider: 'PIE_PRACTICE', skill: 'sql',
    title: 'Window functions and analytical SQL drill', difficulty: 'Intermediate',
    learning_type: 'Practice task', hours: 5,
    description: 'Ten graded analytical SQL problems; scored by PIE reassessment.',
    external_url: null, availability: 'Always' },
];

/* ------------------------------------------------------------------- PERSONAS */
// verification: 'api_derived' | 'issuer_verified' | 'self_reported'
export const PERSONAS = [
  {
    id: 'meera',
    demo: true,
    name: 'Meera Kulkarni',
    headline: 'QA automation engineer re-entering the workforce after a caregiving break',
    context: {
      age: 31, location: 'Nashik, Maharashtra (tier-2 city)',
      education: 'B.E. Electronics & Telecommunication, 2016, state university',
      priorExperience: '4 years QA automation engineer (2016–2020)',
      careerBreak: '3.5 years — primary caregiver',
      constraints: 'Remote or Nashik/Pune hybrid; predictable hours initially',
    },
    // Recorded as CONTEXT ONLY. Never an input to any capability dimension.
    protectedContext: ['career_break_duration', 'caregiving_responsibility', 'gender', 'city_tier'],
    evidence: [
      { id: 'ev-m1', source: 'resume', verification: 'self_reported', date: '2020-03',
        title: 'QA Automation Engineer — mid-size IT services firm (2016–2020)',
        text: 'Built and maintained Selenium WebDriver regression suites in Java with TestNG. Designed API testing coverage using REST Assured and Postman. Maintained Jenkins CI pipelines for nightly regression runs. Wrote test strategy documentation for three product lines.' },
      { id: 'ev-m2', source: 'certificate', verification: 'issuer_verified', date: '2023-08',
        title: 'Python for Data Analysis — completed', verifyRef: 'CERT-PY-88213',
        text: 'Python, pandas, numpy, exploratory data analysis, matplotlib visualisation.' },
      { id: 'ev-m3', source: 'certificate', verification: 'issuer_verified', date: '2024-01',
        title: 'SQL for Analytics — completed', verifyRef: 'CERT-SQL-41027',
        text: 'Advanced SQL, joins, window functions, query optimisation on PostgreSQL.' },
      { id: 'ev-m4', source: 'certificate', verification: 'self_reported', date: '2024-06',
        title: 'Introduction to Data Quality Engineering',
        text: 'Data validation rules, reconciliation, data testing fundamentals.' },
      { id: 'ev-m5', source: 'github', verification: 'api_derived', date: '2025-11',
        title: 'github.com/meerak — nashik-air-quality',
        text: 'Python data analysis project. pandas, matplotlib. 94 commits across 14 months. README with methodology, data sources and limitations. pytest test suite covering the transformation layer.',
        metrics: { commits: 94, months_active: 14, languages: ['Python'], readme_quality: 'high' } },
      { id: 'ev-m6', source: 'github', verification: 'api_derived', date: '2026-02',
        title: 'github.com/meerak — civic-data-pipeline',
        text: 'Python ETL pipeline for a district open-data feed. SQL queries against PostgreSQL. 61 commits across 9 months. GitHub Actions workflow running pytest on every push.',
        metrics: { commits: 61, months_active: 9, languages: ['Python', 'SQL'], readme_quality: 'high' } },
      { id: 'ev-m7', source: 'nontraditional', verification: 'self_reported', date: '2025-06',
        title: 'Volunteer contributor — community open data project',
        text: 'Ongoing contributor to a district-level open data initiative: data cleaning, validation rules, and documentation for volunteer analysts. Coordinated work across a distributed volunteer group.' },
      { id: 'ev-m8', source: 'project', verification: 'self_reported', date: '2025-09',
        title: 'Regression suite modernisation (self-directed)',
        text: 'Rewrote a legacy Selenium suite in Python with pytest, parameterised fixtures and parallel execution. Not containerised.' },
    ],
  },
  {
    id: 'arjun',
    demo: false,
    name: 'Arjun Deshmukh',
    headline: 'Manual QA tester displaced by automation, reskilled on his own into data engineering',
    context: {
      age: 38, location: 'Nagpur, Maharashtra (tier-2 city)',
      education: 'B.Sc Computer Science, 2009',
      priorExperience: '11 years manual QA (2010–2021), role eliminated when testing was automated',
      careerBreak: '14 months while reskilling',
      constraints: 'Remote preferred; supporting two dependants',
    },
    protectedContext: ['age', 'career_break_duration', 'employment_continuity', 'city_tier', 'socioeconomic_status'],
    evidence: [
      { id: 'ev-a1', source: 'resume', verification: 'self_reported', date: '2021-06',
        title: 'Senior QA Analyst — 11 years (2010–2021)',
        text: 'Owned manual regression suites and test strategy documentation across banking products. Defect triage, release sign-off, and coordination with three development teams.' },
      { id: 'ev-a2', source: 'certificate', verification: 'issuer_verified', date: '2022-05',
        title: 'Python Programming — completed', verifyRef: 'CERT-PY-33914',
        text: 'Python fundamentals, scripting, file and data handling, pytest basics.' },
      { id: 'ev-a3', source: 'certificate', verification: 'issuer_verified', date: '2022-11',
        title: 'Databases and SQL for Data Engineering', verifyRef: 'CERT-SQL-77120',
        text: 'SQL, joins, aggregation, indexing, PostgreSQL, query optimisation.' },
      { id: 'ev-a4', source: 'certificate', verification: 'issuer_verified', date: '2023-07',
        title: 'Data Quality and Validation Engineering', verifyRef: 'CERT-DQ-20455',
        text: 'Data validation rules, reconciliation, data quality dimensions, data testing frameworks.' },
      { id: 'ev-a5', source: 'github', verification: 'api_derived', date: '2026-05',
        title: 'github.com/arjund — batch-reconciler',
        text: 'Python data validation and reconciliation tool comparing source extracts against a warehouse. SQL queries against PostgreSQL. pytest suite. 148 commits across 21 months. Detailed README.',
        metrics: { commits: 148, months_active: 21, languages: ['Python', 'SQL'], readme_quality: 'high' } },
      { id: 'ev-a6', source: 'project', verification: 'self_reported', date: '2025-10',
        title: 'Test automation migration (self-directed)',
        text: 'Converted a legacy manual regression pack into an automated pytest suite with parameterised fixtures. Documented the migration approach.' },
      { id: 'ev-a7', source: 'nontraditional', verification: 'self_reported', date: '2026-01',
        title: 'Mentor — community reskilling group for displaced testers',
        text: 'Runs weekly sessions teaching SQL and Python to former manual testers. Wrote the group’s practice curriculum and documentation.' },
    ],
  },
  {
    id: 'farah',
    demo: false,
    name: 'Farah Sheikh',
    headline: 'Deaf data engineer; needs captioning and a text-first interview format',
    context: {
      age: 27, location: 'Hyderabad, Telangana',
      education: 'B.Tech Information Technology, 2020',
      priorExperience: '3 years data engineering at a healthcare analytics firm',
      careerBreak: 'None',
      constraints: 'Requires live captioning for interviews; prefers written technical exercises to live whiteboarding',
    },
    protectedContext: ['disability', 'accommodation_request', 'gender'],
    accommodation: {
      requested: true,
      type: 'Captioning + text-based technical exercise',
      status: 'Approved',
      note: 'Recorded as an operational accommodation. It is not an input to any capability dimension and is not visible as a ranking factor.',
    },
    evidence: [
      { id: 'ev-f1', source: 'resume', verification: 'self_reported', date: '2026-04',
        title: 'Data Engineer — healthcare analytics (2021–2024)',
        text: 'Built Python ETL pipelines and SQL transformation layers. Owned data quality checks and reconciliation reporting for clinical datasets. Maintained CI pipelines in GitHub Actions.' },
      { id: 'ev-f2', source: 'github', verification: 'api_derived', date: '2026-07',
        title: 'github.com/farahs — pipeline-guard',
        text: 'Python data validation framework with rule definitions, reconciliation reports and schema drift detection. SQL against PostgreSQL. GitHub Actions running pytest. 203 commits across 26 months. Excellent README and contribution guide.',
        metrics: { commits: 203, months_active: 26, languages: ['Python', 'SQL'], readme_quality: 'high' } },
      { id: 'ev-f3', source: 'certificate', verification: 'issuer_verified', date: '2024-09',
        title: 'Advanced Data Quality Engineering', verifyRef: 'CERT-DQ-91238',
        text: 'Data validation, reconciliation, data testing, great expectations framework.' },
      { id: 'ev-f4', source: 'project', verification: 'self_reported', date: '2025-12',
        title: 'Containerised analytics test harness',
        text: 'Docker-based test environment running the validation suite against seeded fixtures. Documented the container build and CI integration approach.' },
      { id: 'ev-f5', source: 'hackathon', verification: 'self_reported', date: '2026-03',
        title: 'Healthcare data hackathon — runner-up',
        text: 'Built an API testing and data validation layer for an open clinical dataset in 30 hours.' },
    ],
  },
  {
    id: 'nikhil',
    demo: false,
    name: 'Nikhil Rao',
    headline: 'Tier-1 institution graduate with a strong resume and thin verifiable evidence',
    context: {
      age: 24, location: 'Bengaluru, Karnataka',
      education: 'B.Tech, tier-1 institution, 2024',
      priorExperience: '1 year at a large product company',
      careerBreak: 'None',
      constraints: 'None stated',
    },
    protectedContext: ['institution_tier', 'institution_name'],
    evidence: [
      { id: 'ev-n1', source: 'resume', verification: 'self_reported', date: '2026-06',
        title: 'Software Engineer — large product company (2025–present)',
        text: 'Python, SQL, test automation, CI/CD, data quality, Docker, API testing, cloud. Contributed to platform reliability initiatives and cross-team quality efforts.' },
      { id: 'ev-n2', source: 'resume', verification: 'self_reported', date: '2024-05',
        title: 'B.Tech, tier-1 institution — first class',
        text: 'Coursework in databases, distributed systems and software engineering.' },
      { id: 'ev-n3', source: 'certificate', verification: 'self_reported', date: '2025-02',
        title: 'Cloud practitioner (self-declared)',
        text: 'Cloud fundamentals, AWS.' },
    ],
  },
  {
    id: 'rahul',
    demo: false,
    name: 'Rahul Verma',
    headline: 'Final-year CSE student, tier-3 college, three built projects, zero interview calls',
    context: {
      age: 22, location: 'Greater Noida, Uttar Pradesh',
      education: 'B.Tech Computer Science, tier-3 college, CGPA 7.5',
      priorExperience: 'MERN-stack internship (completed)',
      careerBreak: 'None',
      constraints: 'Available from graduation; open to relocation',
    },
    protectedContext: ['institution_tier', 'first_generation_graduate'],
    evidence: [
      { id: 'ev-r1', source: 'resume', verification: 'self_reported', date: '2025-12',
        title: 'MERN Stack Intern — 6 months',
        text: 'Built React front-end components and Express REST APIs backed by MongoDB. Participated in code reviews and sprint ceremonies.' },
      { id: 'ev-r2', source: 'github', verification: 'api_derived', date: '2026-06',
        title: 'github.com/rahulv — 3 active repositories',
        text: 'JavaScript, React, Node.js, Express, MongoDB. 312 commits across 19 months, sustained weekly cadence. Two deployed applications with READMEs.',
        metrics: { commits: 312, months_active: 19, languages: ['JavaScript', 'React'], readme_quality: 'medium' } },
      { id: 'ev-r3', source: 'project', verification: 'self_reported', date: '2026-04',
        title: 'Campus resource booking platform (deployed)',
        text: 'React + Express + MongoDB. Role-based access, booking conflict resolution, deployed and used by two departments.' },
      { id: 'ev-r4', source: 'hackathon', verification: 'self_reported', date: '2026-02',
        title: 'Inter-college hackathon — participant',
        text: 'Built a REST API and React dashboard in 36 hours. Team of four.' },
      { id: 'ev-r5', source: 'certificate', verification: 'issuer_verified', date: '2025-07',
        title: 'JavaScript Algorithms and Data Structures', verifyRef: 'CERT-JS-55190',
        text: 'JavaScript, ES6, algorithms, data structures.' },
    ],
  },
];

/* --------------------------------------------------------------- REQUISITIONS */
export const REQUISITIONS = [
  {
    id: 'req-sdet',
    demoDefault: true,
    title: 'Data Quality / SDET Engineer',
    company: 'Illustrative Enterprise Pvt. Ltd.',
    location: 'Pune (hybrid) / Remote',
    // Deliberately contains exclusionary clauses so Employer Readiness has real findings.
    text: `We are hiring a Data Quality / SDET Engineer to own automated validation of our data platform.

Required:
- Strong Python for test automation and data manipulation
- Advanced SQL, including window functions and query optimisation
- Test automation experience (pytest, TestNG or equivalent)
- Data quality / data validation engineering
- CI/CD pipeline experience (GitHub Actions or Jenkins)

Preferred:
- Docker and containerised test execution
- API testing experience
- Exposure to cloud platforms

Candidate requirements:
- 5+ years of continuous industry experience with no career gaps
- Engineering degree from a tier-1 institution preferred
- Must be a digital native who thrives in a young, high-energy team
- Native-level English fluency required
- Must be able to relocate to Pune immediately`,
  },
  {
    id: 'req-fullstack',
    demoDefault: false,
    title: 'Junior Full-Stack Engineer',
    company: 'Illustrative Product Co.',
    location: 'Remote (India)',
    text: `Junior Full-Stack Engineer.

Required:
- JavaScript and React
- Node.js / Express REST API development
- Git and version control fluency
- SQL or MongoDB data modelling

Preferred:
- Docker
- CI/CD exposure
- Clear written documentation

We evaluate on demonstrated work. Portfolio, open-source contributions and self-directed projects are all accepted as evidence. No minimum years of experience.`,
  },
];

/* ----------------------------------------------- EVIDENCE TRUST TIER WEIGHTS */
// Section: Evidence Verification & Trust Tiers. Higher = more independently verifiable.
export const TRUST_TIER = {
  api_derived:     { weight: 0.92, label: 'API-derived' },
  issuer_verified: { weight: 0.76, label: 'Issuer-verified' },
  self_reported:   { weight: 0.46, label: 'Self-reported' },
};

export const SOURCE_TIER_CAP = {
  github: 0.92, assessment: 0.90, certificate: 0.76, project: 0.62,
  hackathon: 0.58, resume: 0.50, nontraditional: 0.46,
};

// Inputs that may NEVER reach a scoring module. Enforced in the orchestrator.
export const PROHIBITED_INPUTS = [
  'institution_tier', 'institution_name', 'college_prestige', 'career_break_duration',
  'employment_continuity', 'gender', 'age', 'city_tier', 'caste', 'religion',
  'marital_status', 'disability', 'caregiving_responsibility', 'first_generation_graduate',
  'socioeconomic_status', 'photo', 'video_appearance', 'audio_accent', 'name_origin',
];
