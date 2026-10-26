"""One MCP call; output can contain private data. Do not commit it."""
import argparse
import json
import sys
import trlib

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('tool')
parser.add_argument('arguments', nargs='?', default='{}', help='JSON or - for stdin')
args = parser.parse_args()
value = json.loads(sys.stdin.read() if args.arguments == '-' else args.arguments)
print(json.dumps(trlib.call(args.tool, value), ensure_ascii=False, indent=2))
