import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { fetchRiskResult, ToolError, type PayDeps } from './client.js';

const FACTORS = [
  'deployer_history', 'bundled_launch', 'holder_concentration', 'dev_position',
  'fresh_wallets', 'funding_cluster', 'curve_velocity', 'metadata_flags',
] as const;

export const RUG_RISK_TOOL = {
  name: 'rug_risk_score',
  description: 'Rug-risk score (0-100) for a pump.fun mint with evidence. Costs $0.01 USDC via x402, paid by your wallet.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['mint'],
    properties: { mint: { type: 'string', pattern: '^[1-9A-HJ-NP-Za-km-z]{32,44}$' } },
  },
  // Vendored JSON Schema of RiskResult (INTERFACES §2).
  outputSchema: {
    type: 'object',
    required: ['mint', 'score', 'verdict', 'reasons', 'data_gaps', 'model_version', 'as_of_slot', 'as_of_ts'],
    properties: {
      mint: { type: 'string' },
      score: { type: 'integer', minimum: 0, maximum: 100 },
      verdict: { enum: ['LOW', 'MED', 'HIGH', 'EXTREME'] },
      reasons: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          required: ['factor', 'points', 'detail', 'evidence'],
          properties: {
            factor: { enum: [...FACTORS] },
            points: { type: 'integer', minimum: 1 },
            detail: { type: 'string' },
            evidence: { type: 'object' },
          },
        },
      },
      data_gaps: { type: 'array', items: { enum: [...FACTORS] } },
      model_version: { type: 'string' },
      as_of_slot: { type: 'integer' },
      as_of_ts: { type: 'integer' },
    },
  },
} as const;

const errorResult = (code: string) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }] });

export function createServer(deps: PayDeps): Server {
  const server = new Server({ name: 'pumpwire-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [RUG_RISK_TOOL] }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'rug_risk_score') return errorResult('UPSTREAM');
    const mint = (req.params.arguments as { mint?: unknown } | undefined)?.mint;
    if (typeof mint !== 'string') return errorResult('INVALID_MINT');
    try {
      const result = await fetchRiskResult(deps, mint);
      return {
        structuredContent: result as Record<string, unknown>,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    } catch (e) {
      // Never forward raw error text: it may contain upstream/attacker-influenced strings.
      return errorResult(e instanceof ToolError ? e.code : 'UPSTREAM');
    }
  });
  return server;
}
