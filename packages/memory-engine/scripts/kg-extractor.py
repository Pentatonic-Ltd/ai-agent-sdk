#!/usr/bin/env python3
"""
Knowledge Graph Extractor for Pentatonic Memory Engine
Extracts entities and relationships from memory files and writes them to Neo4j.

Usage:
    python3 kg-extractor.py              # Process all new/modified files
    python3 kg-extractor.py --file path  # Process single file
    python3 kg-extractor.py --stats      # Show extraction stats
    python3 kg-extractor.py --dry-run    # Show what would be extracted
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Set, Tuple, Optional

# Try to import spaCy, fall back to regex if unavailable
try:
    import spacy
    try:
        nlp = spacy.load("en_core_web_sm")
        SPACY_AVAILABLE = True
        print("Using spaCy NER for entity extraction")
    except OSError:
        print("spaCy model 'en_core_web_sm' not found, falling back to regex patterns")
        SPACY_AVAILABLE = False
        nlp = None
except ImportError:
    print("spaCy not available, falling back to regex patterns")
    SPACY_AVAILABLE = False
    nlp = None

try:
    from neo4j import GraphDatabase
except ImportError:
    GraphDatabase = None

# Neo4j connection settings
NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
NEO4J_USER = "neo4j"
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "")

# File paths to process
MEMORY_PATHS = [
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/people/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/daily/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/projects/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/your_project/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/your_company/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/tools/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/rules/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/security/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/research/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/reviews/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/health/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/contacts/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/messages/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/email/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/linkedin/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/KNOWLEDGE_BASE/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "memory/slack/*.md"),
    os.path.join(os.environ.get("PME_DIR", os.path.expanduser("~/pentatonic")), "MEMORY.md"),
]

# State file to track processed files
STATE_FILE = os.path.expanduser("~/.pme/kg-extractor-state.json")

# Regex patterns for fallback entity extraction
ENTITY_PATTERNS = {
    "PERSON": [
        r'\b[A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)*\b',  # Full names only
        r'\b(?:YOUR_HUMAN|CONTACT_1|CONTACT_2|CONTACT_3)\b'  # Known first names from context
    ],
    "ORG": [
        r'\b(?:Google|Microsoft|Apple|Amazon|Meta|Tesla|NVIDIA|OpenAI|Anthropic|DeepMind|YOUR_COMPANY|YOUR_PROJECT|Acme|Globex|Initech|Umbrella)\b',
        r'\b[A-Z][a-zA-Z\s]+(?:Ltd|Inc|Corp|Company|Group|Technologies|Systems|Solutions|Labs|University|College|Institute)\b'
    ],
    "PROJECT": [
        r'\b[A-Z][a-zA-Z\s]+(?:Project|Platform|System|Framework|Tool|API|App)\b',
        r'\b(?:Phase|Sprint|Build|LACG|Neo)\s+\d+\b'
    ],
    "TECHNOLOGY": [
        r'\b(?:Python|JavaScript|React|Node\.js|Docker|Kubernetes|AWS|GCP|Azure|PostgreSQL|MongoDB|Redis|Neo4j|spaCy)\b',
        r'\b[a-z]+\.[a-z]+(?:\.[a-z]+)*\b'  # domain names
    ]
}

# Relationship patterns
RELATIONSHIP_PATTERNS = {
    "WORKS_AT": [
        r'(\w+(?:\s+\w+)*)\s+(?:works\s+(?:at|for)|is\s+(?:at|with)|employed\s+(?:at|by))\s+(\w+(?:\s+\w+)*)',
        r'(\w+(?:\s+\w+)*)\s+(?:@|at)\s+(\w+(?:\s+\w+)*)'
    ],
    "MARRIED_TO": [
        r'(\w+(?:\s+\w+)*)\s+(?:married\s+to|wife\s+of|husband\s+of|spouse\s+of)\s+(\w+(?:\s+\w+)*)',
        r'(\w+(?:\s+\w+)*)\s+and\s+(\w+(?:\s+\w+)*)\s+(?:are\s+)?married'
    ],
    "FRIEND_OF": [
        r'(\w+(?:\s+\w+)*)\s+(?:is\s+(?:friends?\s+with|a\s+friend\s+of|mates?\s+with)|knows)\s+(\w+(?:\s+\w+)*)',
        r'(\w+(?:\s+\w+)*)\s+(?:friend|mate|buddy)\s+(\w+(?:\s+\w+)*)'
    ],
    "KNOWS_PERSON": [
        r'(\w+(?:\s+\w+)*)\s+(?:knows|met|connected\s+with|introduced\s+to)\s+(\w+(?:\s+\w+)*)',
        r'(\w+(?:\s+\w+)*)\s+and\s+(\w+(?:\s+\w+)*)\s+(?:know\s+each\s+other|are\s+connected)'
    ],
    "WORKS_ON": [
        r'(\w+(?:\s+\w+)*)\s+(?:works\s+on|building|developing|created|maintains)\s+(\w+(?:\s+\w+)*)',
        r'(\w+(?:\s+\w+)*)\s+(?:is\s+(?:working\s+on|building|developing))\s+(\w+(?:\s+\w+)*)'
    ]
}

class KGExtractor:
    def __init__(self):
        self.driver = None
        self.stats = {
            "files_processed": 0,
            "entities_extracted": 0,
            "relationships_extracted": 0,
            "entities_created": 0,
            "relationships_created": 0,
            "errors": 0
        }

    def connect_neo4j(self):
        """Connect to Neo4j database"""
        try:
            self.driver = GraphDatabase.driver(NEO4J_URI, auth=(NEO4J_USER, NEO4J_PASSWORD))
            # Test connection
            with self.driver.session() as session:
                session.run("RETURN 1")
            print(f"Connected to Neo4j at {NEO4J_URI}")
        except Exception as e:
            print(f"Failed to connect to Neo4j: {e}")
            return False
        return True

    def close_neo4j(self):
        """Close Neo4j connection"""
        if self.driver:
            self.driver.close()

    def load_state(self) -> Dict:
        """Load processing state from file"""
        if os.path.exists(STATE_FILE):
            try:
                with open(STATE_FILE, 'r') as f:
                    return json.load(f)
            except Exception as e:
                print(f"Error loading state file: {e}")
        return {}

    def save_state(self, state: Dict):
        """Save processing state to file"""
        os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
        try:
            with open(STATE_FILE, 'w') as f:
                json.dump(state, f, indent=2)
        except Exception as e:
            print(f"Error saving state file: {e}")

    def extract_entities_spacy(self, text: str) -> List[Tuple[str, str]]:
        """Extract entities using spaCy NER"""
        entities = []
        if not SPACY_AVAILABLE:
            return entities

        doc = nlp(text)
        for ent in doc.ents:
            if ent.label_ in ["PERSON", "ORG", "GPE", "PRODUCT", "EVENT", "WORK_OF_ART"]:
                entity_type = self._map_spacy_label(ent.label_)
                if self._is_valid_entity(ent.text, entity_type):
                    entities.append((ent.text.strip(), entity_type))

        return entities

    def extract_entities_regex(self, text: str) -> List[Tuple[str, str]]:
        """Extract entities using regex patterns"""
        entities = []
        for entity_type, patterns in ENTITY_PATTERNS.items():
            for pattern in patterns:
                matches = re.finditer(pattern, text, re.IGNORECASE)
                for match in matches:
                    entity_name = match.group().strip()
                    if self._is_valid_entity(entity_name, entity_type):
                        entities.append((entity_name, entity_type))

        return entities

    def extract_relationships(self, text: str) -> List[Tuple[str, str, str, str]]:
        """Extract relationships using pattern matching"""
        relationships = []
        for rel_type, patterns in RELATIONSHIP_PATTERNS.items():
            for pattern in patterns:
                matches = re.finditer(pattern, text, re.IGNORECASE)
                for match in matches:
                    if len(match.groups()) >= 2:
                        entity1 = match.group(1).strip()
                        entity2 = match.group(2).strip()
                        if self._is_valid_entity(entity1, "PERSON") and self._is_valid_entity(entity2, None):
                            extracted_text = match.group().strip()
                            relationships.append((entity1, rel_type, entity2, extracted_text))

        return relationships

    def _map_spacy_label(self, spacy_label: str) -> str:
        """Map spaCy entity labels to our schema"""
        mapping = {
            "PERSON": "PERSON",
            "ORG": "ORG",
            "GPE": "ORG",  # Geopolitical entity -> organization
            "PRODUCT": "PROJECT",
            "EVENT": "PROJECT",
            "WORK_OF_ART": "PROJECT"
        }
        return mapping.get(spacy_label, "UNKNOWN")

    def _is_valid_entity(self, text: str, entity_type: Optional[str]) -> bool:
        """Check if extracted text is a valid entity"""
        text = text.strip()

        # Skip too short or too long
        if len(text) < 2 or len(text) > 100:
            return False

        # Skip common words and technical terms
        skip_words = {
            "the", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
            "is", "are", "was", "were", "been", "be", "have", "has", "had", "do", "does", "did",
            "will", "would", "could", "should", "can", "may", "might", "must",
            "this", "that", "these", "those", "here", "there", "where", "when", "why", "how",
            "what", "which", "who", "whom", "whose", "all", "any", "some", "many", "much",
            "more", "most", "less", "least", "few", "several", "each", "every", "both",
            "either", "neither", "not", "no", "yes", "true", "false", "good", "bad", "new", "old",
            "basic", "info", "role", "email", "communication", "professional", "relationship",
            "part", "quick", "meeting", "deep", "analysis", "context", "style", "leadership"
        }

        if text.lower() in skip_words:
            return False

        # Skip garbage patterns from spaCy misclassification
        garbage_patterns = [
            r'^[A-Z]{2,}$',  # ALL CAPS single words like "CRITICAL", "NEGLIGIBLE", "IDENTIFY"
            r'[\n\r]',  # Contains newlines
            r'^[^a-zA-Z]*$',  # No letters at all
            r'^\d',  # Starts with digit
            r'^(What|How|When|Where|Why|Which|If|Can|Do|Does|Did|Is|Are|Was|Were|Has|Have|Had|Will|Would|Could|Should|May|Might|Must|Let|After|Before|During)\b',  # Starts with question/auxiliary word
            r'^(No |Not |Any |All |Some |Each |Every |Both |Either |Neither |Very |Too |Just )',  # Starts with determiner/adverb
        ]
        for pattern in garbage_patterns:
            if re.match(pattern, text):
                return False

        # Skip very short entities (< 2 chars)
        if len(text.strip()) < 2:
            return False

        # Skip entities that look like markdown/code artifacts
        if any(c in text for c in ['*', '`', '#', '|', '{', '}', '[', ']']):
            return False

        # Skip if starts with common prefixes that indicate it's not a proper entity
        skip_prefixes = ["role at", "part of", "email", "professional", "quick", "manages",
                        "accepts", "invites", "handles", "respects", "active on", "shares",
                        "organises", "authors", "guest", "references to", "with", "on", "and",
                        "for", "to", "the", "basic info", "communication style", "deep analysis",
                        "- active"]

        for prefix in skip_prefixes:
            if text.lower().startswith(prefix):
                return False

        # Must contain at least one letter
        if not re.search(r'[a-zA-Z]', text):
            return False

        # For person names, require proper capitalization and at least 2 words for full names
        if entity_type == "PERSON":
            # Must start with capital letter
            if not text[0].isupper():
                return False
            # If contains space, should be proper name format
            if " " in text and not re.match(r'^[A-Z][a-z]+(?:\s[A-Z][a-z]+)+$', text):
                return False
            # Single names should be common first names
            if " " not in text and len(text) < 3:
                return False

        # For organizations, should contain meaningful words
        if entity_type == "ORG":
            if not re.search(r'[A-Z]', text):
                return False

        return True

    def entity_exists(self, entity_name: str, entity_type: str) -> Optional[str]:
        """Check if entity already exists (case-insensitive fuzzy match)"""
        if not self.driver:
            return None

        label_map = {
            "PERSON": "Person",
            "ORG": "Company",
            "PROJECT": "Project",
            "TECHNOLOGY": "Tool",
        }
        label = label_map.get(entity_type, "Entity")

        with self.driver.session() as session:
            # Exact match first (by label)
            result = session.run(
                f"MATCH (n:{label}) WHERE toLower(n.name) = toLower($name) RETURN n.name",
                name=entity_name
            )

            record = result.single()
            if record:
                return record["n.name"]

            # Also check across all labels (entity may have been created with different type)
            result = session.run(
                "MATCH (n) WHERE toLower(n.name) = toLower($name) RETURN n.name",
                name=entity_name
            )

            record = result.single()
            if record:
                return record["n.name"]

        return None

    def create_entity(self, name: str, entity_type: str, source_file: str, dry_run: bool = False) -> str:
        """Create or merge entity in Neo4j"""
        if dry_run:
            print(f"  [DRY] Would create entity: {name} ({entity_type}) from {source_file}")
            return name

        # Check if exists
        existing = self.entity_exists(name, entity_type)
        if existing:
            return existing

        if not self.driver:
            return name

        # Map entity type to Neo4j label
        label_map = {
            "PERSON": "Person",
            "ORG": "Company",
            "PROJECT": "Project",
            "TECHNOLOGY": "Tool",
        }
        label = label_map.get(entity_type, "Entity")

        with self.driver.session() as session:
            session.run(
                f"MERGE (n:{label} {{name: $name}}) SET n.type = $type, n.source_file = $source_file, n.created_at = datetime()",
                name=name, type=entity_type, source_file=source_file
            )
            self.stats["entities_created"] += 1

        return name

    def create_relationship(self, entity1: str, rel_type: str, entity2: str, source_file: str, extracted_from: str, dry_run: bool = False):
        """Create relationship between entities"""
        if dry_run:
            print(f"  [DRY] Would create relationship: {entity1} -> {rel_type} -> {entity2} from {source_file}")
            return

        if not self.driver:
            return

        with self.driver.session() as session:
            session.run("""
                MATCH (a {name: $entity1}), (b {name: $entity2})
                MERGE (a)-[r:RELATIONSHIP {type: $rel_type}]->(b)
                SET r.source_file = $source_file, r.extracted_from = $extracted_from, r.created_at = datetime()
                """,
                entity1=entity1, entity2=entity2, rel_type=rel_type,
                source_file=source_file, extracted_from=extracted_from
            )
            self.stats["relationships_created"] += 1

    def process_file(self, file_path: str, dry_run: bool = False) -> bool:
        """Process a single file for entity and relationship extraction"""
        try:
            print(f"Processing: {file_path}")

            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # Extract entities
            if SPACY_AVAILABLE:
                entities = self.extract_entities_spacy(content)
            else:
                entities = self.extract_entities_regex(content)

            # Also try regex for additional coverage
            regex_entities = self.extract_entities_regex(content)
            entities.extend(regex_entities)

            # Remove duplicates
            entities = list(set(entities))

            # Extract relationships
            relationships = self.extract_relationships(content)

            print(f"  Found {len(entities)} entities, {len(relationships)} relationships")

            # Create entities
            entity_names = {}
            for entity_name, entity_type in entities:
                canonical_name = self.create_entity(entity_name, entity_type, file_path, dry_run)
                entity_names[entity_name] = canonical_name
                self.stats["entities_extracted"] += 1

            # Create relationships
            for entity1, rel_type, entity2, extracted_text in relationships:
                # Use canonical names if available
                canonical_entity1 = entity_names.get(entity1, entity1)
                canonical_entity2 = entity_names.get(entity2, entity2)

                self.create_relationship(canonical_entity1, rel_type, canonical_entity2,
                                       file_path, extracted_text, dry_run)
                self.stats["relationships_extracted"] += 1

            self.stats["files_processed"] += 1
            return True

        except Exception as e:
            print(f"Error processing {file_path}: {e}")
            self.stats["errors"] += 1
            return False

    def get_files_to_process(self, force_all: bool = False) -> List[str]:
        """Get list of files that need processing"""
        import glob

        state = self.load_state()
        files_to_process = []

        for pattern in MEMORY_PATHS:
            for file_path in glob.glob(pattern):
                if os.path.isfile(file_path):
                    # Check if file is new or modified
                    mtime = os.path.getmtime(file_path)
                    last_processed = state.get(file_path, 0)

                    if force_all or mtime > last_processed:
                        files_to_process.append(file_path)

        return sorted(files_to_process)

    def update_state(self, file_path: str):
        """Update state after processing a file"""
        state = self.load_state()
        state[file_path] = os.path.getmtime(file_path)
        self.save_state(state)

    def show_stats(self):
        """Show extraction statistics"""
        if not self.driver:
            print("No Neo4j connection to show stats")
            return

        with self.driver.session() as session:
            # Count entities by type
            result = session.run("MATCH (n) RETURN n.type as type, count(*) as count ORDER BY count DESC")

            print("\n=== Knowledge Graph Statistics ===")
            print("\nEntities by type:")
            for record in result:
                print(f"  {record['type']}: {record['count']}")

            # Count relationships by type
            result = session.run("MATCH ()-[r]->() WHERE r.type IS NOT NULL RETURN r.type as type, count(*) as count ORDER BY count DESC")

            print("\nRelationships by type:")
            for record in result:
                print(f"  {record['type']}: {record['count']}")

            # Show recent extractions
            result = session.run("MATCH (n) WHERE n.created_at IS NOT NULL RETURN n.name, n.type, n.created_at ORDER BY n.created_at DESC LIMIT 10")

            print("\nRecently created entities:")
            for record in result:
                print(f"  {record['n.name']} ({record['n.type']}) - {record['n.created_at']}")

def main():
    parser = argparse.ArgumentParser(description="Extract knowledge graph from memory files")
    parser.add_argument("--file", help="Process single file")
    parser.add_argument("--stats", action="store_true", help="Show extraction statistics")
    parser.add_argument("--dry-run", action="store_true", help="Show what would be extracted without writing to Neo4j")
    parser.add_argument("--force", action="store_true", help="Force reprocess all files")

    args = parser.parse_args()

    extractor = KGExtractor()

    if args.stats:
        if extractor.connect_neo4j():
            extractor.show_stats()
            extractor.close_neo4j()
        return

    # Connect to Neo4j (unless dry run)
    if not args.dry_run:
        if not extractor.connect_neo4j():
            print("Failed to connect to Neo4j. Use --dry-run to test extraction without database.")
            return

    try:
        if args.file:
            # Process single file
            if os.path.isfile(args.file):
                extractor.process_file(args.file, args.dry_run)
                if not args.dry_run:
                    extractor.update_state(args.file)
            else:
                print(f"File not found: {args.file}")
        else:
            # Process all new/modified files
            files = extractor.get_files_to_process(args.force)

            if not files:
                print("No new or modified files to process")
                return

            print(f"Found {len(files)} files to process")

            for file_path in files:
                success = extractor.process_file(file_path, args.dry_run)
                if success and not args.dry_run:
                    extractor.update_state(file_path)

        # Print final stats
        print(f"\n=== Extraction Complete ===")
        print(f"Files processed: {extractor.stats['files_processed']}")
        print(f"Entities extracted: {extractor.stats['entities_extracted']}")
        print(f"Relationships extracted: {extractor.stats['relationships_extracted']}")
        if not args.dry_run:
            print(f"Entities created: {extractor.stats['entities_created']}")
            print(f"Relationships created: {extractor.stats['relationships_created']}")
        print(f"Errors: {extractor.stats['errors']}")

    finally:
        if not args.dry_run:
            extractor.close_neo4j()

if __name__ == "__main__":
    main()
