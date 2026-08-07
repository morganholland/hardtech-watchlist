// One-off backfill of the founder-pedigree screen (labelled seed set).
//
// Seeds the sourceCompanies registry and a pedigree record for ~26 companies
// so the enrichment pipeline has a labelled set to test against. Companies not
// yet on the watchlist are added; existing companies only gain a `pedigree`
// object — nothing else on the record is touched.
//
// Guardrails are enforced here, not just promised: every evidence URL is
// fetched during the run and must return 200, or the entry is dropped and the
// founder downgraded to unverified (null score, verification queue). Scores
// are computed by scripts/pedigree.mjs — deterministic, reproducible by hand.
//
//   node scripts/seed-pedigree.mjs [--dry-run]
//
// Safe to re-run: a company whose pedigree already exists is skipped unless
// --force is given.

import { readFileSync, writeFileSync } from "node:fs";
import { scorePedigree, deriveFlags, validatePedigree, normName } from "./pedigree.mjs";

const DATA_PATH = new URL("../data/companies.json", import.meta.url).pathname;
const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const TODAY = new Date().toISOString().slice(0, 10);

// The elite hard-tech companies whose alumni the screen recognizes. Data, not
// code — second-generation spawners (Impulse, Varda, Castelion, Base Power)
// can be added here later without touching any script.
const SOURCE_REGISTRY = {
  "spacex":            { label: "SpaceX",            weight: 1.0,  domains: ["space", "defense", "energy", "manufacturing"] },
  "tesla":             { label: "Tesla",             weight: 1.0,  domains: ["energy", "batteries", "manufacturing"] },
  "anduril":           { label: "Anduril",           weight: 0.95, domains: ["defense", "manufacturing"] },
  "waymo":             { label: "Waymo",             weight: 0.85, domains: ["robotics", "autonomy"] },
  "palantir":          { label: "Palantir",          weight: 0.85, domains: ["defense", "software"] },
  "neuralink":         { label: "Neuralink",         weight: 0.8,  domains: ["neurotech", "hardware"] },
  "applied-intuition": { label: "Applied Intuition", weight: 0.75, domains: ["autonomy", "defense"] },
  "zipline":           { label: "Zipline",           weight: 0.75, domains: ["robotics", "aviation"] },
  "boring-company":    { label: "The Boring Company", weight: 0.7, domains: ["manufacturing"] },
  "rocket-lab":        { label: "Rocket Lab",        weight: 0.7,  domains: ["space"] },
  "astranis":          { label: "Astranis",          weight: 0.65, domains: ["space"] },
};

// Labelled seed set. `company` is present only for companies not already on
// the watchlist. Founder years follow the user-supplied labels; yearsPrecision
// records where each number came from. Evidence URLs were all retrieved
// (HTTP 200) when this dataset was assembled and are re-fetched on every run.
const SEED = [
  // ------------------------------------------------------------- SpaceX ----
  {
    name: "Impulse Space",
    founders: [{
      name: "Tom Mueller", roleAtCompany: "Founder & CEO", source: "spacex",
      title: "VP of Propulsion Engineering (CTO of Propulsion)", ownership: "cofounder-exec",
      startYear: 2002, endYear: 2020, years: 18, yearsPrecision: "derived",
      note: "SpaceX employee #1; led Merlin and Raptor propulsion development.",
      confidence: "verified",
      evidence: [
        { claim: "Founding employee and propulsion CTO at SpaceX, 2002-2020", url: "https://en.wikipedia.org/wiki/Tom_Mueller", publisher: "Wikipedia" },
        { claim: "Founder & CEO of Impulse Space", url: "https://www.impulsespace.com/", publisher: "Impulse Space (company site)" },
      ],
    }],
  },
  {
    name: "Epsilon3",
    company: { theme: "space", tier: "growth", stage: "Series A ($15M)", oneLiner: "Web platform for spacecraft test & mission operations procedures", investors: ["Moore Strategic", "YC", "MaC"], status: "private", website: "https://www.epsilon3.io/" },
    founders: [{
      name: "Laura Crabtree", roleAtCompany: "Co-founder & CEO", source: "spacex",
      title: "Senior Mission Operations Engineer", ownership: "senior-ic",
      years: 11, yearsPrecision: "reported",
      note: "Trained crew and flew Dragon missions across a decade of SpaceX mission ops.",
      confidence: "verified",
      evidence: [
        { claim: "Led SpaceX mission operations work for over a decade before founding Epsilon3", url: "https://techcrunch.com/2021/03/18/co-founded-by-a-leader-of-spacexs-missions-operations-epsilon3-wants-to-be-the-os-for-space-launches/", publisher: "TechCrunch" },
        { claim: "Epsilon3 raised a $15M Series A; Crabtree is co-founder & CEO", url: "https://spacenews.com/epsilon3-raises-15-million-for-space-project-management-platform/", publisher: "SpaceNews" },
      ],
    }],
  },
  {
    name: "Reliable Robotics",
    company: { theme: "robotics", tier: "growth", stage: "Series C+", oneLiner: "Certified autonomous flight systems for cargo aircraft", investors: ["Eclipse", "Coatue"], status: "private", website: "https://reliable.co/" },
    founders: [
      {
        name: "Juerg Frefel", roleAtCompany: "Co-founder & CTO", source: "spacex",
        title: "Senior Hardware Development Manager", ownership: "functional-head",
        years: 9.5, yearsPrecision: "reported",
        note: "Led the team building the compute platform for Falcon 9 and Dragon.",
        confidence: "single-source",
        evidence: [
          { claim: "Co-founder of Reliable Robotics; led Falcon 9/Dragon compute platform development at SpaceX", url: "https://theorg.com/org/reliable-robotics", publisher: "The Org" },
        ],
      },
      {
        name: "Robert Rose", roleAtCompany: "Co-founder & CEO", source: "spacex",
        title: "Director of Flight Software", ownership: "functional-head",
        years: 5.5, yearsPrecision: "reported",
        note: "Led Falcon 9 / Dragon onboard flight software; later Senior Director of Autopilot at Tesla.",
        confidence: "verified",
        evidence: [
          { claim: "Director of Flight Software at SpaceX before co-founding Reliable Robotics", url: "https://eclipse.capital/company/reliable-robotics/", publisher: "Eclipse Ventures" },
          { claim: "Co-founder & CEO of Reliable Robotics", url: "https://theorg.com/org/reliable-robotics", publisher: "The Org" },
        ],
      },
    ],
  },
  {
    name: "Argo Space",
    company: { theme: "space", tier: "seed", stage: "Seed", oneLiner: "Reusable spacecraft refueled with water harvested in space", investors: ["Type One"], status: "private" },
    founders: [
      {
        name: "Ryan Carlisle", roleAtCompany: "Co-founder & CTO", source: "spacex",
        title: "Director of Launch Engineering", ownership: "functional-head",
        years: 9, yearsPrecision: "reported",
        note: "Led engineering teams on Starship and Falcon 9; worked on in-space refueling with NASA.",
        confidence: "single-source",
        evidence: [
          { claim: "Director of launch engineering at SpaceX; led Starship and Falcon 9 engineering teams", url: "https://techcrunch.com/2023/04/13/spacex-to-build-spacecraft-powered-by-moon-water/", publisher: "TechCrunch" },
        ],
      },
      {
        name: "Robert Carlisle", roleAtCompany: "Co-founder & CEO", source: "spacex",
        title: "Director of Commercial Launch & National Security Sales", ownership: "functional-head",
        years: 5, yearsPrecision: "reported",
        confidence: "single-source",
        evidence: [
          { claim: "Ex-SpaceX; co-founded Argo Space with his brothers after sales leadership roles", url: "https://techcrunch.com/2023/04/13/spacex-to-build-spacecraft-powered-by-moon-water/", publisher: "TechCrunch" },
        ],
      },
    ],
  },
  {
    name: "Turion Space",
    company: { theme: "space", tier: "growth", stage: "Series B ($75M, Apr 2026)", oneLiner: "Satellites for space domain awareness & debris removal", investors: ["YC", "Washington Harbour"], status: "private", website: "https://turionspace.com/" },
    founders: [{
      name: "Ryan Westerdahl", roleAtCompany: "Co-founder & CEO", source: "spacex",
      title: "Dynamics Engineer", ownership: "senior-ic",
      years: 8, yearsPrecision: "reported",
      confidence: "verified",
      evidence: [
        { claim: "Ex-SpaceX engineer; co-founded Turion Space (YC S21)", url: "https://payloadspace.com/exclusive-turion-space-closes-4-7m-seed-round/", publisher: "Payload" },
        { claim: "Turion Space founding team came from SpaceX", url: "https://www.ycombinator.com/companies/turion-space", publisher: "Y Combinator" },
      ],
    }],
  },
  {
    name: "Plantd",
    company: { theme: "energy", tier: "growth", stage: "Series B", oneLiner: "Carbon-negative building materials from fast-growing grass", investors: ["American Dynamism"], status: "private", website: "https://www.plantdmaterials.com/" },
    founders: [{
      name: "Nathan Silvernail", roleAtCompany: "Co-founder", source: "spacex",
      title: "Engineering Manager, Crew & Cargo Dragon", ownership: "functional-head",
      years: 7, yearsPrecision: "reported",
      confidence: "verified",
      evidence: [
        { claim: "Ex-SpaceX engineering leadership; co-founded Plantd (company's own site)", url: "https://www.plantdmaterials.com/", publisher: "Plantd (company site)" },
      ],
    }],
  },
  {
    name: "Apex",
    founders: [{
      name: "Max Benassi", roleAtCompany: "Co-founder & CTO", source: "spacex",
      title: "Senior Propulsion Engineer, Raptor Turbomachinery", ownership: "senior-ic",
      years: 6, yearsPrecision: "reported",
      note: "Scaled aerospace component production at SpaceX; later Director of Engineering at Astra.",
      confidence: "verified",
      evidence: [
        { claim: "Scaled aerospace manufacturing at SpaceX before co-founding Apex (company's own about page)", url: "https://www.apexspace.com/about", publisher: "Apex (company site)" },
      ],
    }],
  },
  {
    name: "K2 Space",
    founders: [{
      name: "Neel Kunjur", roleAtCompany: "Co-founder & CTO", source: "spacex",
      title: "Senior Avionics Engineer, Dragon 2", ownership: "senior-ic",
      years: 5.5, yearsPrecision: "reported",
      confidence: "verified",
      evidence: [
        { claim: "Ex-SpaceX avionics engineer; co-founded K2 Space (company's own site)", url: "https://www.k2space.com/", publisher: "K2 Space (company site)" },
      ],
    }],
  },
  {
    name: "Varda",
    founders: [{
      name: "Will Bruey", roleAtCompany: "Co-founder & CEO", source: "spacex",
      title: "Senior Avionics Engineer / Spacecraft Operator, Crew Dragon", ownership: "senior-ic",
      years: 6, yearsPrecision: "reported",
      note: "Worked on Falcon/Dragon video systems, then Crew Dragon avionics actuators and controllers.",
      confidence: "verified",
      evidence: [
        { claim: "Six years at SpaceX on Dragon systems before co-founding Varda", url: "https://techcrunch.com/2020/12/08/space-manufacturing-startup-varda-incubated-at-founders-fund-emerges-with-9-million-in-funding/", publisher: "TechCrunch" },
        { claim: "Co-founder & CEO of Varda (company's own story page)", url: "https://www.varda.com/company", publisher: "Varda (company site)" },
      ],
    }],
  },
  {
    name: "Castelion",
    founders: [
      {
        name: "Bryon Hargis", roleAtCompany: "Co-founder & CEO", source: "spacex",
        title: "Led National Security Satellite Sales & Business Development", ownership: "functional-head",
        years: 5, yearsPrecision: "reported",
        confidence: "verified",
        evidence: [
          { claim: "Led SpaceX national security satellite sales before co-founding Castelion (company's own about page)", url: "https://www.castelion.com/about-us/", publisher: "Castelion (company site)" },
          { claim: "SpaceX veterans founded Castelion; $100M raise", url: "https://spacenews.com/spacex-veterans-hypersonic-weapons-startup-secures-100-million/", publisher: "SpaceNews" },
        ],
      },
      {
        name: "Sean Pitt", roleAtCompany: "Co-founder & COO", source: "spacex",
        title: "Led European Launch & Human Spaceflight Sales", ownership: "functional-head",
        years: 5, yearsPrecision: "reported",
        confidence: "verified",
        evidence: [
          { claim: "Led SpaceX launch and human spaceflight sales in Europe before co-founding Castelion", url: "https://www.castelion.com/about-us/", publisher: "Castelion (company site)" },
        ],
      },
    ],
  },
  {
    name: "Long Wall",
    company: { theme: "defense", tier: "growth", stage: "Growth (fka ABL Space)", oneLiner: "Deployable launch vehicles & infrastructure for missile defense", investors: [], status: "private" },
    founders: [{
      name: "Harry O'Hanley", roleAtCompany: "Co-founder & CEO", source: "spacex",
      title: "Manager, Falcon 9 Integration & Test", ownership: "program-owner",
      years: 4, yearsPrecision: "reported",
      confidence: "single-source",
      evidence: [
        { claim: "Manager of Falcon 9 integration and test at SpaceX before founding ABL (now Long Wall)", url: "https://en.wikipedia.org/wiki/Long_Wall_(aerospace_company)", publisher: "Wikipedia" },
      ],
    }],
  },
  {
    name: "Ambrosia Energy",
    company: { theme: "energy", tier: "seed", stage: "Seed (DFJ Growth)", oneLiner: "Vertically integrated solar + storage for AI data centers", investors: ["DFJ Growth"], status: "private", website: "https://ambrosia.energy/" },
    founders: [
      {
        name: "Ben Longmier", roleAtCompany: "Co-founder & CEO", source: "spacex",
        title: "Co-led Starlink Mobile", ownership: "program-owner",
        years: 4, yearsPrecision: "reported",
        note: "Joined SpaceX via its acquisition of Swarm Technologies, which he co-founded.",
        confidence: "verified",
        evidence: [
          { claim: "Former SpaceX Starlink leader; co-founded Ambrosia Energy", url: "https://techcrunch.com/2026/06/10/why-two-spacex-alumni-are-betting-on-solar-and-batteries-to-power-the-ai-craze/", publisher: "TechCrunch" },
          { claim: "Co-founder of Ambrosia Energy (company's own site)", url: "https://ambrosia.energy/", publisher: "Ambrosia Energy (company site)" },
        ],
      },
      {
        name: "Sara Spangelo", roleAtCompany: "Co-founder & President", source: "spacex",
        title: "Starlink (via Swarm acquisition)", ownership: "senior-ic",
        years: 4, yearsPrecision: "reported",
        note: "Co-founded and was CEO of Swarm Technologies, acquired by SpaceX in 2021.",
        confidence: "verified",
        evidence: [
          { claim: "Worked on Starlink after SpaceX acquired her startup Swarm", url: "https://techcrunch.com/2026/06/10/why-two-spacex-alumni-are-betting-on-solar-and-batteries-to-power-the-ai-craze/", publisher: "TechCrunch" },
        ],
      },
    ],
  },
  {
    name: "General Matter",
    company: { theme: "nuclear", tier: "growth", stage: "$900M DOE contract (Jan 2026)", oneLiner: "Domestic HALEU uranium enrichment at commercial scale", investors: ["Founders Fund"], status: "private", website: "https://www.generalmatter.com/" },
    founders: [{
      name: "Scott Nolan", roleAtCompany: "Founder & CEO", source: "spacex",
      title: "Early Engineer, Merlin Engine & Dragon", ownership: "senior-ic",
      years: null, yearsPrecision: "unknown",
      note: "Early SpaceX engineer on Merlin and Dragon; then 13 years leading hard-tech investing at Founders Fund. Title outweighs an unrecorded duration — rendered as a label, not a bar.",
      confidence: "verified",
      evidence: [
        { claim: "Early SpaceX engineer on Merlin/Dragon; founded General Matter", url: "https://en.wikipedia.org/wiki/General_Matter", publisher: "Wikipedia" },
        { claim: "Ex-SpaceX engineer leads General Matter's uranium enrichment push", url: "https://www.world-nuclear-news.org/articles/us-uranium-enrichment-startup-emerges-from-stealth", publisher: "World Nuclear News" },
      ],
    }],
  },
  {
    name: "TerraFirma",
    company: { theme: "space", tier: "seed", stage: "Stealth", oneLiner: "Stealth company reportedly founded by ex-SpaceX engineers", investors: [], status: "private" },
    founders: [{
      name: null, roleAtCompany: "Co-founders (unnamed)", source: "spacex",
      title: null, ownership: "unknown",
      years: null, yearsPrecision: "unknown",
      note: "Press reports 'two ex-SpaceX engineers' with no names or titles — nothing to verify yet.",
      confidence: "unverified",
      evidence: [],
    }],
  },
  {
    name: "Rebellions",
    company: { theme: "semis", tier: "growth", stage: "Series C (Korea)", oneLiner: "AI inference accelerator chips (Seoul)", investors: [], status: "private", website: "https://rebellions.ai/" },
    founders: [{
      name: "Sunghyun Park", roleAtCompany: "Co-founder & CEO", source: "spacex",
      title: "Starlink ASIC Design Engineer", ownership: "senior-ic",
      years: 1, yearsPrecision: "estimated",
      note: "Short SpaceX stint; a prestigious logo does not outweigh ~1 year of tenure.",
      confidence: "single-source",
      evidence: [
        { claim: "Starlink ASIC design engineer at SpaceX before founding Rebellions", url: "https://aimagazine.com/executive/sunghyun-park", publisher: "AI Magazine" },
      ],
    }],
  },
  // -------------------------------------------------------------- Tesla ----
  {
    name: "Heron Power",
    company: { theme: "energy", tier: "growth", stage: "Series A ($38M)", oneLiner: "Solid-state transformers for the grid interconnection bottleneck", investors: ["Capricorn"], status: "private", website: "https://www.heronpower.com/" },
    founders: [{
      name: "Drew Baglino", roleAtCompany: "Founder & CEO", source: "tesla",
      title: "SVP, Powertrain & Energy Engineering", ownership: "cofounder-exec",
      startYear: 2006, endYear: 2024, years: 18, yearsPrecision: "derived",
      confidence: "verified",
      evidence: [
        { claim: "SVP of powertrain and energy engineering at Tesla, 2006-2024", url: "https://en.wikipedia.org/wiki/Drew_Baglino", publisher: "Wikipedia" },
        { claim: "Founder & CEO of Heron Power (company's own site)", url: "https://www.heronpower.com/", publisher: "Heron Power (company site)" },
      ],
    }],
  },
  {
    name: "Redwood Materials",
    founders: [{
      name: "JB Straubel", roleAtCompany: "Founder & CEO", source: "tesla",
      title: "Co-founder & CTO", ownership: "cofounder-exec",
      startYear: 2005, endYear: 2019, years: 14, yearsPrecision: "derived",
      confidence: "verified",
      evidence: [
        { claim: "Tesla co-founder and long-time CTO", url: "https://en.wikipedia.org/wiki/J._B._Straubel", publisher: "Wikipedia" },
        { claim: "Founded Redwood Materials after leaving Tesla", url: "https://en.wikipedia.org/wiki/Redwood_Materials", publisher: "Wikipedia" },
      ],
    }],
  },
  {
    name: "Form Energy",
    company: { theme: "energy", tier: "growth", stage: "Series F ($405M)", oneLiner: "Iron-air batteries for 100-hour grid storage", investors: ["Breakthrough"], status: "private", website: "https://formenergy.com/" },
    founders: [{
      name: "Mateo Jaramillo", roleAtCompany: "Co-founder & CEO", source: "tesla",
      title: "VP, Products & Programs, Tesla Energy", ownership: "program-owner",
      years: 6, yearsPrecision: "reported",
      note: "Started and ran Tesla's stationary energy storage program.",
      confidence: "verified",
      evidence: [
        { claim: "Former head of Tesla's stationary storage program; co-founded Form Energy in 2017", url: "https://en.wikipedia.org/wiki/Form_Energy", publisher: "Wikipedia" },
        { claim: "VP of products and programs for Tesla's stationary storage effort", url: "https://energy.stanford.edu/people/mateo-jaramillo", publisher: "Stanford Precourt Institute" },
      ],
    }],
  },
  {
    name: "Lunar Energy",
    company: { theme: "energy", tier: "growth", stage: "Series B", oneLiner: "Home battery + energy management systems", investors: ["Sunrun", "SK Group"], status: "private", website: "https://www.lunarenergy.com/" },
    founders: [{
      name: "Kunal Girotra", roleAtCompany: "Founder & CEO", source: "tesla",
      title: "Ran Tesla Energy (Senior Director)", ownership: "program-owner",
      years: 6, yearsPrecision: "reported",
      confidence: "verified",
      evidence: [
        { claim: "Ran Tesla's Energy business before founding Lunar Energy (company's own site)", url: "https://www.lunarenergy.com/", publisher: "Lunar Energy (company site)" },
      ],
    }],
  },
  {
    name: "Span",
    company: { theme: "energy", tier: "growth", stage: "Series C", oneLiner: "Smart electrical panels for home electrification", investors: [], status: "private", website: "https://www.span.io/" },
    founders: [{
      name: "Arch Rao", roleAtCompany: "Founder & CEO", source: "tesla",
      title: "Head of Products, Tesla Energy", ownership: "functional-head",
      years: 5.5, yearsPrecision: "reported",
      note: "Led the Powerwall product team.",
      confidence: "single-source",
      evidence: [
        { claim: "Former head of Tesla Energy products; founded Span", url: "https://techcrunch.com/2021/05/19/span-introduces-a-new-home-electric-panel/", publisher: "TechCrunch" },
      ],
    }],
  },
  {
    name: "Pila",
    company: { theme: "energy", tier: "seed", stage: "Seed ($4M, Oct 2025)", oneLiner: "Plug-in mesh home batteries for renters and homeowners", investors: [], status: "private", website: "https://pilaenergy.com/" },
    founders: [{
      name: "Cole Ashman", roleAtCompany: "Founder & CEO", source: "tesla",
      title: "Product Engineer, Powerwall", ownership: "senior-ic",
      years: 4, yearsPrecision: "reported",
      note: "Later led product at Span before founding Pila.",
      confidence: "single-source",
      evidence: [
        { claim: "Engineered on Tesla's Powerwall and SPAN's panel before founding Pila", url: "https://www.canarymedia.com/articles/batteries/pila-plug-in-backup-power-renters-homes", publisher: "Canary Media" },
      ],
    }],
  },
  // ------------------------------------------------------------ Anduril ----
  {
    name: "Base Power",
    founders: [
      {
        name: "Justin Lopas", roleAtCompany: "Co-founder & COO", source: "anduril",
        title: "Head of Manufacturing", ownership: "program-owner",
        startYear: 2020, endYear: 2023, years: 3, yearsPrecision: "derived",
        note: "Built Anduril manufacturing to a 150+ person team. Dual-source record: also ~4y at SpaceX (below); the stronger stint carries the score, nothing is double-counted.",
        confidence: "verified",
        evidence: [
          { claim: "Head of manufacturing at Anduril before co-founding Base Power (company's own about page)", url: "https://www.basepowercompany.com/about", publisher: "Base Power (company site)" },
        ],
      },
      {
        name: "Justin Lopas", roleAtCompany: "Co-founder & COO", source: "spacex",
        title: "Lead Manufacturing Engineer", ownership: "senior-ic",
        years: 4, yearsPrecision: "reported",
        confidence: "verified",
        evidence: [
          { claim: "Lead manufacturing engineer at SpaceX before Anduril (company's own about page)", url: "https://www.basepowercompany.com/about", publisher: "Base Power (company site)" },
        ],
      },
    ],
  },
  {
    name: "Layup Parts",
    company: { theme: "defense", tier: "growth", stage: "Series A ($42M, Jun 2026)", oneLiner: "On-demand composite parts manufacturing — the Amazon of composites", investors: ["Marlinspike", "Founders Fund", "Lux"], status: "private", website: "https://www.layupparts.com/" },
    founders: [
      {
        name: "Zack Eakin", roleAtCompany: "Founder & CEO", source: "anduril",
        title: "Director of Mechanical Engineering", ownership: "functional-head",
        startYear: 2021, endYear: 2024, years: 3, yearsPrecision: "derived",
        confidence: "verified",
        evidence: [
          { claim: "Ex-Anduril engineer (2021-2024); raised $42M Series A for Layup Parts", url: "https://techcrunch.com/2026/06/02/ex-anduril-engineer-raises-42m-to-build-the-amazon-of-composite-parts/", publisher: "TechCrunch" },
          { claim: "Worked at The Boring Company and Anduril before founding Layup", url: "https://3dprint.com/309521/boring-company-alum-score-9m-for-advanced-composites-manufacturing/", publisher: "3DPrint.com" },
        ],
      },
      {
        name: "Zack Eakin", roleAtCompany: "Founder & CEO", source: "boring-company",
        title: "Early Engineer", ownership: "senior-ic",
        years: 3, yearsPrecision: "estimated",
        confidence: "single-source",
        evidence: [
          { claim: "Boring Company alum before Anduril", url: "https://3dprint.com/309521/boring-company-alum-score-9m-for-advanced-composites-manufacturing/", publisher: "3DPrint.com" },
        ],
      },
    ],
  },
  {
    name: "Agon",
    company: { theme: "defense", tier: "seed", stage: "Seed ($30M, Jul 2026)", oneLiner: "Synthetic battlefields to train Europe's defense AI", investors: [], status: "private" },
    founders: [
      {
        name: "Tristam Constant", roleAtCompany: "Co-founder & CEO", source: "anduril",
        title: "Senior Director, Europe", ownership: "functional-head",
        years: 2, yearsPrecision: "estimated",
        note: "Dual-source record: previously ran Applied Intuition's European defense business (below). 13 years in the British Army before industry.",
        confidence: "verified",
        evidence: [
          { claim: "Senior director of Europe at Anduril before founding Agon", url: "https://tech.eu/2026/07/29/british-defence-startup-agon-creating-virtual-battlefields-launches-raising-30m/", publisher: "Tech.eu" },
          { claim: "Ex-Anduril and Applied Intuition duo raise $30M for Agon", url: "https://techfundingnews.com/agon-30m-seed-defence-ai-training-data/", publisher: "Tech Funding News" },
        ],
      },
      {
        name: "Tristam Constant", roleAtCompany: "Co-founder & CEO", source: "applied-intuition",
        title: "Head of European Defence", ownership: "functional-head",
        years: 2, yearsPrecision: "estimated",
        confidence: "verified",
        evidence: [
          { claim: "Led Applied Intuition's European defense business", url: "https://tech.eu/2026/07/29/british-defence-startup-agon-creating-virtual-battlefields-launches-raising-30m/", publisher: "Tech.eu" },
        ],
      },
    ],
  },
  {
    name: "Harbinger",
    founders: [{
      name: "William Eberts", roleAtCompany: "Co-founder & COO", source: "anduril",
      title: "Engineering Project Manager", ownership: "senior-ic",
      years: 2, yearsPrecision: "estimated",
      note: "Thin record by design: project-level role, short estimated tenure — the screen should not reward the logo alone.",
      confidence: "verified",
      evidence: [
        { claim: "Co-founded Harbinger; prior EV and aerospace experience including Anduril", url: "https://en.wikipedia.org/wiki/Harbinger_(company)", publisher: "Wikipedia" },
        { claim: "Harbinger founding team announcement", url: "https://www.prnewswire.com/news-releases/new-oem-harbinger-unveils-first-of-its-kind-commercial-medium-duty-platform-set-to-electrify-and-revolutionize-the-industry-301619727.html", publisher: "PR Newswire" },
      ],
    }],
  },
  // -------------------------------------------------------------- Waymo ----
  {
    name: "Bedrock Robotics",
    company: { theme: "robotics", tier: "growth", stage: "Series B ($270M)", oneLiner: "Retrofit autonomy for construction & heavy equipment", investors: ["Eclipse", "8VC"], status: "private", website: "https://www.bedrockrobotics.com/" },
    founders: [
      {
        name: "Boris Sofman", roleAtCompany: "Co-founder & CEO", source: "waymo",
        title: "Senior Director of Engineering & Head of Trucking", ownership: "program-owner",
        years: 5, yearsPrecision: "reported",
        note: "Previously co-founded Anki and ran it for ~10 years.",
        confidence: "verified",
        evidence: [
          { claim: "Led Waymo's autonomous trucking program for ~5 years before founding Bedrock", url: "https://techcrunch.com/2025/07/16/ex-waymo-engineers-launch-bedrock-robotics-with-80m-to-automate-construction/", publisher: "TechCrunch" },
          { claim: "Bedrock Series B announcement; Sofman CEO", url: "https://www.prnewswire.com/news-releases/bedrock-robotics-raises-270-million-in-series-b-funding-to-accelerate-the-future-of-autonomous-construction-302679014.html", publisher: "PR Newswire" },
        ],
      },
      {
        name: "Ajay Gummalla", roleAtCompany: "Co-founder", source: "waymo",
        title: "Director of Systems and Programs", ownership: "functional-head",
        years: 7, yearsPrecision: "reported",
        confidence: "single-source",
        evidence: [
          { claim: "Waymo veteran; co-founded Bedrock Robotics", url: "https://techcrunch.com/2025/07/16/ex-waymo-engineers-launch-bedrock-robotics-with-80m-to-automate-construction/", publisher: "TechCrunch" },
        ],
      },
    ],
  },
  // ---------------------------------------------------------- Neuralink ----
  {
    name: "Science Corp",
    company: { theme: "robotics", tier: "growth", stage: "Series B+", oneLiner: "Brain-computer interfaces & neurotech tools (ex-Neuralink founders)", investors: ["Khosla"], status: "private", website: "https://science.xyz/" },
    founders: [
      {
        name: "Max Hodak", roleAtCompany: "Founder & CEO", source: "neuralink",
        title: "Co-founder & President", ownership: "cofounder-exec",
        startYear: 2016, endYear: 2021, years: 5, yearsPrecision: "derived",
        confidence: "verified",
        evidence: [
          { claim: "Co-founded Neuralink and served as president until 2021", url: "https://en.wikipedia.org/wiki/Max_Hodak", publisher: "Wikipedia" },
          { claim: "Founder & CEO of Science Corp (company's own site)", url: "https://science.xyz/", publisher: "Science Corp (company site)" },
        ],
      },
      {
        name: "Alan Mardinly", roleAtCompany: "Leadership team", source: "neuralink",
        title: null, ownership: "unknown",
        years: null, yearsPrecision: "unknown",
        note: "Reported as ex-Neuralink leadership; no retrievable source states a title or tenure yet.",
        confidence: "unverified",
        evidence: [],
      },
    ],
  },
];

async function fetchOk(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "hardtech-watchlist/1.0" },
      redirect: "follow",
      signal: AbortSignal.timeout(20000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function main() {
  const db = JSON.parse(readFileSync(DATA_PATH, "utf8"));
  db.sourceCompanies = { ...SOURCE_REGISTRY, ...(db.sourceCompanies ?? {}) };

  // Retrieve every evidence URL once. Anything that doesn't come back 200 is
  // dropped, and a founder left without evidence is downgraded to unverified.
  const urls = [...new Set(SEED.flatMap((s) => s.founders.flatMap((f) => (f.evidence ?? []).map((e) => e.url))))];
  console.log(`verifying ${urls.length} evidence URLs...`);
  const alive = new Map();
  for (const url of urls) {
    const ok = await fetchOk(url);
    alive.set(url, ok);
    if (!ok) console.warn(`  ! ${url} did not return 200 — dropping`);
  }

  const added = [], upgraded = [];
  for (const seed of SEED) {
    const key = normName(seed.name);
    let company = db.companies.find((c) => normName(c.name) === key);
    if (!company) {
      company = { name: seed.name, oneLiner: "", investors: [], status: "private", ...seed.company };
      db.companies.push(company);
      added.push(seed.name);
    }
    if (company.pedigree && !FORCE) { console.log(`  = ${seed.name}: pedigree exists, skipping (use --force)`); continue; }

    const founders = structuredClone(seed.founders);
    for (const f of founders) {
      f.evidence = (f.evidence ?? [])
        .filter((e) => alive.get(e.url))
        .map((e) => ({ ...e, retrievedAt: TODAY }));
      if (f.confidence !== "unverified" && f.evidence.length === 0) {
        console.warn(`  ! ${seed.name}/${f.name}: all evidence failed — downgraded to unverified`);
        f.confidence = "unverified";
      } else if (f.confidence === "verified" && f.evidence.length === 1 && !/company site/.test(f.evidence[0].publisher)) {
        // verified needs two independent sources or one primary source
        f.confidence = "single-source";
      }
    }

    const pedigree = {
      screened: true,
      tier: null, score: null,
      sourceCompanies: [...new Set(founders.map((f) => f.source))],
      founders,
      lastVerified: TODAY,
      flags: [],
    };
    const { score, tier } = scorePedigree(pedigree, company.theme, db.sourceCompanies);
    pedigree.score = score;
    pedigree.tier = tier;
    pedigree.flags = deriveFlags(pedigree, company.theme, db.sourceCompanies);
    company.pedigree = pedigree;
    upgraded.push(`${company.name} → ${tier}`);
    console.log(`  + ${company.name}: ${tier}${score != null ? ` (${score})` : ""}`);
  }

  // One summary line, matching the "(seed) Initial list..." convention —
  // per-company pedigree lines in the Δ ledger are for incremental enrichment
  // runs, not a bulk backfill.
  if (added.length || upgraded.length) {
    const tiers = {};
    for (const u of upgraded) tiers[u.split("→ ")[1]] = (tiers[u.split("→ ")[1]] ?? 0) + 1;
    db.changelog.unshift({
      date: TODAY,
      added: added.length ? [`(pedigree seed) ${added.length} companies from the labelled founder set`] : [],
      updated: [],
      pedigree: [`(pedigree seed) ${upgraded.length} companies screened — ${Object.entries(tiers).map(([t, n]) => `${n} ${t}`).join(", ")}`],
    });
    db.changelog = db.changelog.slice(0, 30);
  }

  const errors = validatePedigree(db);
  if (errors.length) {
    console.error(`\n${errors.length} guardrail violation(s) — not writing:`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    process.exit(1);
  }

  console.log(`\n${added.length} companies added, ${upgraded.length} pedigrees written`);
  if (DRY_RUN) { console.log("--dry-run: not writing"); return; }
  writeFileSync(DATA_PATH, JSON.stringify(db, null, 2) + "\n");
  console.log(`wrote ${DATA_PATH}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
