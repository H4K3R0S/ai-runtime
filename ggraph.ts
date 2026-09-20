#!/usr/bin/env node
/**
 * ggraph.ts — OS-level CLI za globalni atomski graf (Second Brain nad celim sistemom).
 *
 * Ovaj sloj je namenjen da stoji NAD CELIM OPERATIVNIM SISTEMOM: jedan globalni
 * graf koji indeksira sve entitete (Mete, IP adrese, YouTube skripte, Filmovi, beleške)
 * bez obzira odakle se poziva. Radi nad jedinstvenim vault-om:
 *   ~/ai/core-infrastructure/vector-dbs/global_graph_vault/
 *
 * Upotreba (dostupno svuda kao `ggraph`):
 *   ggraph add <type> <title> [-b "telo"] [-t tag1,tag2] [-i eksplicitni-id]
 *   ggraph get <id>
 *   ggraph list [--type <type>]
 *   ggraph link <fromId> <toId>
 *   ggraph backlinks <id>
 *   ggraph graph
 *   ggraph where           # ispiši putanju vault-a
 */

import { GlobalGraphManager, EntityType } from './globalGraphManager';

function parseFlags(argv: string[]): { pos: string[]; flags: Record<string, string> } {
  const pos: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-b' || a === '--body') flags.body = argv[++i] ?? '';
    else if (a === '-t' || a === '--tags') flags.tags = argv[++i] ?? '';
    else if (a === '-i' || a === '--id') flags.id = argv[++i] ?? '';
    else if (a === '--type') flags.type = argv[++i] ?? '';
    else pos.push(a);
  }
  return { pos, flags };
}

function main(): void {
  const [cmd, ...rest] = process.argv.slice(2);
  const g = new GlobalGraphManager();
  const { pos, flags } = parseFlags(rest);

  switch (cmd) {
    case 'add': {
      const [type, ...titleParts] = pos;
      const title = titleParts.join(' ');
      if (!type || !title) return fail('upotreba: ggraph add <type> <title> [-b telo] [-t tag1,tag2] [-i id]');
      const node = g.createAtom({
        type: type as EntityType,
        title,
        body: flags.body,
        id: flags.id,
        tags: flags.tags ? flags.tags.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
      });
      console.log(`OK: ${node.frontmatter.id} (${node.filePath})`);
      break;
    }
    case 'get': {
      const [id] = pos;
      if (!id) return fail('upotreba: ggraph get <id>');
      const n = g.readAtom(id);
      console.log(JSON.stringify({ ...n.frontmatter, links: n.links, body: n.body }, null, 2));
      break;
    }
    case 'list': {
      const nodes = flags.type ? g.byType(flags.type as EntityType) : g.readAll();
      for (const n of nodes) console.log(`${n.frontmatter.type.padEnd(16)} ${n.frontmatter.id}  —  ${n.frontmatter.title}`);
      if (nodes.length === 0) console.log('(prazno)');
      break;
    }
    case 'link': {
      const [from, to] = pos;
      if (!from || !to) return fail('upotreba: ggraph link <fromId> <toId>');
      g.linkAtoms(from, to);
      console.log(`OK: ${GlobalGraphManager.slugify(from)} -> ${GlobalGraphManager.slugify(to)}`);
      break;
    }
    case 'backlinks': {
      const [id] = pos;
      if (!id) return fail('upotreba: ggraph backlinks <id>');
      const bl = g.backlinks(id);
      console.log(bl.length ? bl.join('\n') : '(nema backlink-ova)');
      break;
    }
    case 'graph': {
      console.log(JSON.stringify(g.buildGraph(), null, 2));
      break;
    }
    case 'where': {
      console.log(g.vaultDir);
      break;
    }
    default:
      fail(
        [
          'ggraph — globalni atomski graf nad celim OS-om',
          '',
          'komande:',
          '  add <type> <title> [-b telo] [-t tagovi] [-i id]',
          '  get <id>',
          '  list [--type <type>]',
          '  link <fromId> <toId>',
          '  backlinks <id>',
          '  graph',
          '  where',
        ].join('\n'),
      );
  }
}

function fail(msg: string): void {
  console.error(msg);
  process.exitCode = 1;
}

main();
