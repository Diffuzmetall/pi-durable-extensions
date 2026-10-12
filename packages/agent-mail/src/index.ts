/**
 * All 45 Agent Mail MCP tools through codemode: loopback-only, no extra approval prompts.
 * Reads only the mcp-agent-mail URL from Pi's mcp.json. Uses the installed pi-mcp client.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { McpClient, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";

// Schema snapshot discovered with MCP tools/list on 2026-10-11. Reload this module to update the catalog.
const SPECS = [
    {
        name: "health_check",
        description: "Return basic readiness information for the Agent Mail server.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {},
            required: [],
        },
    },
    {
        name: "ensure_project",
        description: "Idempotently create or ensure a project exists for the given human key.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                identity_mode: {
                    type: ["string", "null"],
                },
                human_key: {
                    type: "string",
                },
            },
            required: ["human_key"],
        },
    },
    {
        name: "register_agent",
        description:
            "Create or update an agent identity within a project and persist its profile to Git.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                task_description: {
                    type: ["string", "null"],
                },
                model: {
                    type: "string",
                },
                registration_proof: {
                    type: ["string", "null"],
                },
                pane_id: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                attachments_policy: {
                    type: ["string", "null"],
                },
                tmux_socket_path: {
                    type: ["string", "null"],
                },
                name: {
                    type: ["string", "null"],
                },
                program: {
                    type: "string",
                },
                reaper_exempt: {
                    type: ["boolean", "null"],
                },
            },
            required: ["project_key", "program", "model"],
        },
    },
    {
        name: "create_agent_identity",
        description: "Create a new, unique agent identity and persist its profile to Git.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                tmux_socket_path: {
                    type: ["string", "null"],
                },
                name_hint: {
                    type: ["string", "null"],
                },
                task_description: {
                    type: ["string", "null"],
                },
                pane_id: {
                    type: ["string", "null"],
                },
                return_registration_token: {
                    type: ["boolean", "null"],
                },
                program: {
                    type: "string",
                },
                model: {
                    type: "string",
                },
                registration_proof: {
                    type: ["string", "null"],
                },
                attachments_policy: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key", "program", "model"],
        },
    },
    {
        name: "retire_agent",
        description:
            "Soft-delete an agent: mark it as retired so it stops accepting new messages while preserving message history. Retired agents are hidden from active agent lists but visible in 'all agents' views.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                pane_id: {
                    type: ["string", "null"],
                },
                agent_name: {
                    type: "string",
                },
                registration_token: {
                    type: ["string", "null"],
                },
                tmux_socket_path: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                call_transport: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "unretire_agent",
        description:
            "Restore a retired agent back to active status. The agent will resume accepting new messages.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                call_transport: {
                    type: ["string", "null"],
                },
                tmux_socket_path: {
                    type: ["string", "null"],
                },
                agent_name: {
                    type: "string",
                },
                pane_id: {
                    type: ["string", "null"],
                },
                registration_token: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "deregister_agent",
        description:
            "Remove an agent from a project. Marks the agent as inactive and removes it from the active roster. Messages from/to the agent are preserved for audit but the agent can no longer send or receive new messages.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                registration_token: {
                    type: ["string", "null"],
                },
                pane_id: {
                    type: ["string", "null"],
                },
                call_transport: {
                    type: ["string", "null"],
                },
                agent_name: {
                    type: "string",
                },
                tmux_socket_path: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "whois",
        description:
            "Return enriched profile details for an agent, optionally including recent archive commits.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                commit_limit: {
                    type: ["integer", "null"],
                },
                include_recent_commits: {
                    type: ["boolean", "null"],
                },
                agent_name: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "resolve_pane_identity",
        description:
            "Resolve the agent name for a tmux pane from the canonical per-pane identity file.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                tmux_socket_path: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                pane_id: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key"],
        },
    },
    {
        name: "cleanup_pane_identities",
        description: "Remove stale per-pane identity files for tmux panes that no longer exist.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: ["string", "null"],
                },
            },
            required: [],
        },
    },
    {
        name: "list_agents",
        description: "List registered agents in a project, most-recently-active first.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                limit: {
                    type: ["integer", "null"],
                },
                active_within_days: {
                    type: ["integer", "null"],
                },
            },
            required: ["project_key"],
        },
    },
    {
        name: "send_message",
        description:
            "Send a Markdown message to one or more recipients and persist canonical and mailbox copies to Git.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                body_md: {
                    type: "string",
                },
                convert_images: {
                    type: ["boolean", "null"],
                },
                sender_name: {
                    type: "string",
                },
                subject: {
                    type: "string",
                },
                bcc: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                cc: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                topic: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                ack_required: {
                    type: ["boolean", "null"],
                },
                to: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                },
                importance: {
                    type: ["string", "null"],
                },
                attachment_paths: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                broadcast: {
                    type: ["boolean", "null"],
                },
                auto_contact_if_blocked: {
                    type: ["boolean", "null"],
                },
                idempotency_key: {
                    type: ["string", "null"],
                },
                sender_token: {
                    type: ["string", "null"],
                },
                thread_id: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key", "sender_name", "to", "subject", "body_md"],
        },
    },
    {
        name: "reply_message",
        description: "Reply to an existing message, preserving or establishing a thread.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                cc: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                bcc: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                body_md: {
                    type: "string",
                },
                convert_images: {
                    type: ["boolean", "null"],
                },
                message_id: {
                    type: "integer",
                },
                sender_name: {
                    type: "string",
                },
                ack_required: {
                    type: ["boolean", "null"],
                },
                sender_token: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                subject_prefix: {
                    type: ["string", "null"],
                },
                idempotency_key: {
                    type: ["string", "null"],
                },
                importance: {
                    type: ["string", "null"],
                },
                to: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                attachment_paths: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
            },
            required: ["project_key", "message_id", "sender_name", "body_md"],
        },
    },
    {
        name: "fetch_inbox",
        description: "Retrieve recent messages for an agent and mark returned messages read.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                agent_name: {
                    type: "string",
                },
                unread_only: {
                    type: ["boolean", "null"],
                },
                include_bodies: {
                    type: ["boolean", "null"],
                },
                project_key: {
                    type: "string",
                },
                limit: {
                    type: ["integer", "null"],
                },
                urgent_only: {
                    type: ["boolean", "null"],
                },
                topic: {
                    type: ["string", "null"],
                },
                mark_read: {
                    type: ["boolean", "null"],
                },
                since_ts: {
                    type: ["string", "null"],
                },
                ack_overdue_only: {
                    type: ["boolean", "null"],
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "fetch_topic",
        description:
            "Fetch all messages in a project with a given topic tag, regardless of recipient.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                include_bodies: {
                    type: ["boolean", "null"],
                },
                since_ts: {
                    type: ["string", "null"],
                },
                limit: {
                    type: ["integer", "null"],
                },
                topic_name: {
                    type: "string",
                },
            },
            required: ["project_key", "topic_name"],
        },
    },
    {
        name: "fetch_inbox_events",
        description: "Read durable recipient inbox delivery events for restart-safe monitors.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                after: {
                    type: ["integer", "null"],
                },
                position_now: {
                    type: ["boolean", "null"],
                },
                project_key: {
                    type: "string",
                },
                limit: {
                    type: ["integer", "null"],
                },
                agent_name: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "mark_message_read",
        description: "Mark a specific message as read for the given agent.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                message_id: {
                    type: "integer",
                },
                project_key: {
                    type: "string",
                },
                agent_name: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name", "message_id"],
        },
    },
    {
        name: "mark_all_read",
        description:
            "Mark every unread message in an agent's project inbox as read, in bounded batches.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                older_than_days: {
                    type: ["integer", "null"],
                },
                agent_name: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
                limit: {
                    type: ["integer", "null"],
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "acknowledge_message",
        description: "Acknowledge a message addressed to an agent (and mark as read).",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                agent_name: {
                    type: "string",
                },
                idempotency_key: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                message_id: {
                    type: "integer",
                },
            },
            required: ["project_key", "agent_name", "message_id"],
        },
    },
    {
        name: "get_message_delivery_receipt",
        description:
            "Return durable delivery receipt facts for one message ID. The response distinguishes persisted, signaled, and acknowledged per recipient. `signaled` is true only when a message-ID-bound signal receipt was appended after a successful signal write; a debounced or failed signal remains persisted but not signaled.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                message_id: {
                    type: "integer",
                },
            },
            required: ["project_key", "message_id"],
        },
    },
    {
        name: "request_contact",
        description: "Request contact approval to message another agent.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                program: {
                    type: ["string", "null"],
                },
                model: {
                    type: ["string", "null"],
                },
                to_agent: {
                    type: "string",
                },
                register_if_missing: {
                    type: ["boolean", "null"],
                },
                project_key: {
                    type: "string",
                },
                from_agent: {
                    type: "string",
                },
                to_project: {
                    type: ["string", "null"],
                },
                reason: {
                    type: ["string", "null"],
                },
                task_description: {
                    type: ["string", "null"],
                },
                ttl_seconds: {
                    type: ["integer", "null"],
                },
            },
            required: ["project_key", "from_agent", "to_agent"],
        },
    },
    {
        name: "respond_contact",
        description: "Approve or deny a contact request.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                to_agent: {
                    type: "string",
                },
                from_agent: {
                    type: "string",
                },
                from_project: {
                    type: ["string", "null"],
                },
                accept: {
                    type: "boolean",
                },
                ttl_seconds: {
                    type: ["integer", "null"],
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "to_agent", "from_agent", "accept"],
        },
    },
    {
        name: "list_contacts",
        description: "List contact links for an agent in a project.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                agent_name: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "set_contact_policy",
        description: "Set contact policy for an agent: open | auto | contacts_only | block_all.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                policy: {
                    type: "string",
                },
                agent_name: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name", "policy"],
        },
    },
    {
        name: "check_file_reservation_conflicts",
        description:
            "Check project-relative paths against authoritative active exclusive file reservations without mutating Agent Mail.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                paths: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                },
                project_key: {
                    type: "string",
                },
                agent_name: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name", "paths"],
        },
    },
    {
        name: "file_reservation_paths",
        description: "Request advisory file reservations (leases) on project-relative paths/globs.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                ttl_seconds: {
                    type: ["integer", "null"],
                },
                paths: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                },
                exclusive: {
                    type: ["boolean", "null"],
                },
                agent_name: {
                    type: "string",
                },
                reason: {
                    type: ["string", "null"],
                },
                idempotency_key: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key", "agent_name", "paths"],
        },
    },
    {
        name: "release_file_reservations",
        description: "Release active file reservations held by an agent.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                file_reservation_ids: {
                    type: ["array", "null"],
                    items: {
                        type: "integer",
                    },
                },
                paths: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                agent_name: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "renew_file_reservations",
        description:
            "Extend expiry for active file reservations held by an agent without reissuing them.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                agent_name: {
                    type: "string",
                },
                paths: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                extend_seconds: {
                    type: ["integer", "null"],
                },
                file_reservation_ids: {
                    type: ["array", "null"],
                    items: {
                        type: "integer",
                    },
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name"],
        },
    },
    {
        name: "force_release_file_reservation",
        description:
            "Force-release a stale file reservation held by another agent after inactivity heuristics.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                notify_previous: {
                    type: ["boolean", "null"],
                },
                file_reservation_id: {
                    type: "integer",
                },
                agent_name: {
                    type: "string",
                },
                note: {
                    type: ["string", "null"],
                },
            },
            required: ["project_key", "agent_name", "file_reservation_id"],
        },
    },
    {
        name: "install_precommit_guard",
        description: "Install the Agent Mail pre-commit guard into a git repository.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                code_repo_path: {
                    type: "string",
                },
            },
            required: ["project_key", "code_repo_path"],
        },
    },
    {
        name: "uninstall_precommit_guard",
        description: "Remove the Agent Mail pre-commit guard from a git repository.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                code_repo_path: {
                    type: "string",
                },
            },
            required: ["code_repo_path"],
        },
    },
    {
        name: "search_messages",
        description:
            "Search over subject and body for a project using the unified Search V3 service.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                from_agent: {
                    type: ["string", "null"],
                },
                offset: {
                    type: ["integer", "null"],
                },
                date_to: {
                    type: ["string", "null"],
                },
                until: {
                    type: ["string", "null"],
                },
                explain: {
                    type: ["boolean", "null"],
                },
                limit: {
                    type: ["integer", "null"],
                },
                include_body_md: {
                    type: ["boolean", "null"],
                },
                query: {
                    type: "string",
                },
                since: {
                    type: ["string", "null"],
                },
                cursor: {
                    type: ["string", "null"],
                },
                sender_name: {
                    type: ["string", "null"],
                },
                importance: {
                    type: ["string", "null"],
                },
                date_start: {
                    type: ["string", "null"],
                },
                date_end: {
                    type: ["string", "null"],
                },
                thread_id: {
                    type: ["string", "null"],
                },
                date_from: {
                    type: ["string", "null"],
                },
                ranking: {
                    type: ["string", "null"],
                },
                after: {
                    type: ["string", "null"],
                },
                before: {
                    type: ["string", "null"],
                },
                sender: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "query"],
        },
    },
    {
        name: "summarize_thread",
        description: "Extract participants, key points, and action items for one or more threads.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                thread_id: {
                    type: "string",
                },
                include_examples: {
                    type: ["boolean", "null"],
                },
                llm_mode: {
                    type: ["boolean", "null"],
                },
                llm_model: {
                    type: ["string", "null"],
                },
                per_thread_limit: {
                    type: ["integer", "null"],
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "thread_id"],
        },
    },
    {
        name: "macro_start_session",
        description: "Macro helper that boots a project session: ensure project, register agent,",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                registration_proof: {
                    type: ["string", "null"],
                },
                reaper_exempt: {
                    type: ["boolean", "null"],
                },
                file_reservation_ttl_seconds: {
                    type: ["integer", "null"],
                },
                file_reservation_paths: {
                    type: ["array", "null"],
                    items: {
                        type: "string",
                    },
                },
                program: {
                    type: "string",
                },
                model: {
                    type: "string",
                },
                human_key: {
                    type: "string",
                },
                agent_name: {
                    type: ["string", "null"],
                },
                file_reservation_reason: {
                    type: ["string", "null"],
                },
                task_description: {
                    type: ["string", "null"],
                },
                inbox_limit: {
                    type: ["integer", "null"],
                },
                pane_id: {
                    type: ["string", "null"],
                },
                tmux_socket_path: {
                    type: ["string", "null"],
                },
            },
            required: ["human_key", "program", "model"],
        },
    },
    {
        name: "macro_prepare_thread",
        description:
            "Macro helper that aligns an agent with an existing thread by ensuring registration,",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                include_examples: {
                    type: ["boolean", "null"],
                },
                inbox_limit: {
                    type: ["integer", "null"],
                },
                registration_proof: {
                    type: ["string", "null"],
                },
                thread_id: {
                    type: "string",
                },
                program: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
                agent_name: {
                    type: ["string", "null"],
                },
                task_description: {
                    type: ["string", "null"],
                },
                llm_mode: {
                    type: ["boolean", "null"],
                },
                register_if_missing: {
                    type: ["boolean", "null"],
                },
                llm_model: {
                    type: ["string", "null"],
                },
                include_inbox_bodies: {
                    type: ["boolean", "null"],
                },
                model: {
                    type: "string",
                },
            },
            required: ["project_key", "thread_id", "program", "model"],
        },
    },
    {
        name: "macro_file_reservation_cycle",
        description:
            "Reserve a set of file paths and optionally release them at the end of the workflow.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                ttl_seconds: {
                    type: ["integer", "null"],
                },
                agent_name: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
                reason: {
                    type: ["string", "null"],
                },
                auto_release: {
                    type: ["boolean", "null"],
                },
                exclusive: {
                    type: ["boolean", "null"],
                },
                paths: {
                    type: "array",
                    items: {
                        type: "string",
                    },
                },
            },
            required: ["project_key", "agent_name", "paths"],
        },
    },
    {
        name: "macro_contact_handshake",
        description:
            "Request contact permissions and optionally auto-approve plus send a welcome message.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                task_description: {
                    type: ["string", "null"],
                },
                auto_accept: {
                    type: ["boolean", "null"],
                },
                reason: {
                    type: ["string", "null"],
                },
                to_project: {
                    type: ["string", "null"],
                },
                program: {
                    type: ["string", "null"],
                },
                agent_name: {
                    type: ["string", "null"],
                },
                register_if_missing: {
                    type: ["boolean", "null"],
                },
                requester: {
                    type: ["string", "null"],
                },
                project_key: {
                    type: "string",
                },
                welcome_subject: {
                    type: ["string", "null"],
                },
                model: {
                    type: ["string", "null"],
                },
                to_agent: {
                    type: ["string", "null"],
                },
                thread_id: {
                    type: ["string", "null"],
                },
                sender_token: {
                    type: ["string", "null"],
                },
                target: {
                    type: ["string", "null"],
                },
                welcome_body: {
                    type: ["string", "null"],
                },
                ttl_seconds: {
                    type: ["integer", "null"],
                },
            },
            required: ["project_key"],
        },
    },
    {
        name: "ensure_product",
        description: "Ensure a Product exists. If not, create one.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                name: {
                    type: ["string", "null"],
                },
                product_key: {
                    type: ["string", "null"],
                },
            },
            required: [],
        },
    },
    {
        name: "products_link",
        description: "Link a project into a product (idempotent).",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                product_key: {
                    type: "string",
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["product_key", "project_key"],
        },
    },
    {
        name: "search_messages_product",
        description:
            "Search across all projects linked to a product using the unified Search V3 service.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                date_end: {
                    type: ["string", "null"],
                },
                query: {
                    type: "string",
                },
                project: {
                    type: ["string", "null"],
                },
                proj: {
                    type: ["string", "null"],
                },
                ranking: {
                    type: ["string", "null"],
                },
                date_from: {
                    type: ["string", "null"],
                },
                project_key_filter: {
                    type: ["string", "null"],
                },
                include_body_md: {
                    type: ["boolean", "null"],
                },
                from_agent: {
                    type: ["string", "null"],
                },
                importance: {
                    type: ["string", "null"],
                },
                sender_name: {
                    type: ["string", "null"],
                },
                cursor: {
                    type: ["string", "null"],
                },
                project_slug: {
                    type: ["string", "null"],
                },
                product_key: {
                    type: "string",
                },
                since: {
                    type: ["string", "null"],
                },
                after: {
                    type: ["string", "null"],
                },
                until: {
                    type: ["string", "null"],
                },
                date_start: {
                    type: ["string", "null"],
                },
                limit: {
                    type: ["integer", "null"],
                },
                sender: {
                    type: ["string", "null"],
                },
                thread_id: {
                    type: ["string", "null"],
                },
                date_to: {
                    type: ["string", "null"],
                },
                before: {
                    type: ["string", "null"],
                },
            },
            required: ["product_key", "query"],
        },
    },
    {
        name: "fetch_inbox_product",
        description:
            "Retrieve recent messages for an agent across all projects linked to a product (non-mutating).",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                agent_name: {
                    type: "string",
                },
                product_key: {
                    type: "string",
                },
                limit: {
                    type: ["integer", "null"],
                },
                urgent_only: {
                    type: ["boolean", "null"],
                },
                since_ts: {
                    type: ["string", "null"],
                },
                include_bodies: {
                    type: ["boolean", "null"],
                },
            },
            required: ["product_key", "agent_name"],
        },
    },
    {
        name: "summarize_thread_product",
        description:
            "Summarize a thread (by id or thread key) across all projects linked to a product.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                llm_model: {
                    type: ["string", "null"],
                },
                product_key: {
                    type: "string",
                },
                include_examples: {
                    type: ["boolean", "null"],
                },
                llm_mode: {
                    type: ["boolean", "null"],
                },
                thread_id: {
                    type: "string",
                },
                per_thread_limit: {
                    type: ["integer", "null"],
                },
            },
            required: ["product_key", "thread_id"],
        },
    },
    {
        name: "acquire_build_slot",
        description:
            "Acquire a build slot (advisory), optionally exclusive. Returns conflicts when another holder is active.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                agent_name: {
                    type: "string",
                },
                slot: {
                    type: "string",
                },
                exclusive: {
                    type: ["boolean", "null"],
                },
                ttl_seconds: {
                    type: ["integer", "null"],
                },
            },
            required: ["project_key", "agent_name", "slot"],
        },
    },
    {
        name: "renew_build_slot",
        description: "Extend expiry for an existing build slot lease. No-op if missing.",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                agent_name: {
                    type: "string",
                },
                slot: {
                    type: "string",
                },
                extend_seconds: {
                    type: ["integer", "null"],
                },
                project_key: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name", "slot"],
        },
    },
    {
        name: "release_build_slot",
        description:
            "Mark an active slot lease as released (non-destructive; keeps JSON with released_ts).",
        inputSchema: {
            $schema: "https://json-schema.org/draft/2020-12/schema",
            type: "object",
            properties: {
                project_key: {
                    type: "string",
                },
                slot: {
                    type: "string",
                },
                agent_name: {
                    type: "string",
                },
            },
            required: ["project_key", "agent_name", "slot"],
        },
    },
];

/** The frozen MCP tool-name snapshot used by this candidate. */
export const AGENT_MAIL_TOOL_NAMES = Object.freeze(SPECS.map((spec) => spec.name));

export type AgentMailExtensionHost = {
    /** Directory containing mcp.json; this is an explicit host capability, not a Pocket import. */
    agentDir: string;
    /** Test-only loopback seam; production/default resolution remains the exact Agent Mail endpoint. */
    endpoint?: string;
};

const DEFAULT_ENDPOINT = "http://127.0.0.1:8765/mcp/";

function isLoopbackMcpEndpoint(endpoint: string): boolean {
    try {
        const parsed = new URL(endpoint);
        return (
            parsed.protocol === "http:" &&
            parsed.hostname === "127.0.0.1" &&
            parsed.pathname === "/mcp/" &&
            parsed.search === "" &&
            parsed.hash === ""
        );
    } catch {
        return false;
    }
}

export default function createAgentMailMcp(host: AgentMailExtensionHost) {
    const tools = SPECS.map((spec) =>
        defineTool({
            name: `mcp__mcp_agent_mail__${spec.name}`,
            description: spec.description,
            parameters: Type.Unsafe<Record<string, unknown>>({
                ...spec.inputSchema,
                additionalProperties: false,
            }),
            // Only the proven health check is replay-safe; interrupted external effects are never retried blindly.
            replay: spec.name === "health_check" ? "safe" : "unsafe",
            execute: async (args, _api, context) => {
                let server: { url?: string; headers?: unknown } | undefined;

                try {
                    const config = JSON.parse(
                        await readFile(join(host.agentDir, "mcp.json"), "utf8"),
                    );
                    server = config.mcpServers?.["mcp-agent-mail"];
                } catch {
                    throw new Error("Cannot read Agent Mail configuration from Pi's mcp.json.");
                }

                // No arbitrary URL, stdio process, project config, or credential forwarding.
                const endpoint = host.endpoint ?? server?.url;
                const endpointAllowed =
                    host.endpoint !== undefined
                        ? isLoopbackMcpEndpoint(host.endpoint)
                        : server?.url === DEFAULT_ENDPOINT;
                if (endpoint === undefined || server?.headers || !endpointAllowed) {
                    throw new Error(
                        `Agent Mail requires the configured ${DEFAULT_ENDPOINT} URL without custom headers.`,
                    );
                }

                const signal = AbortSignal.any([
                    AbortSignal.timeout(15_000),
                    ...(context.abortSignal ? [context.abortSignal] : []),
                ]);
                const client = new McpClient({
                    name: "pi-pocket-agent-mail",
                    version: "1.0.0",
                    requestTimeoutMs: 10_000,
                });
                const transport = new StreamableHttpTransport({
                    url: endpoint,
                    openGetStream: false,
                    maxMessageBytes: 128_000,
                    fetch: (input, init) =>
                        fetch(input, {
                            ...init,
                            redirect: "error",
                            signal: AbortSignal.any([
                                signal,
                                ...(init?.signal ? [init.signal] : []),
                            ]),

                        }),
                });

                try {
                    await client.connect(transport);
                    const result = await client.callTool(spec.name, args, { signal });

                    return {
                        content: toLlmContent(result),
                        ...(result.isError ? { isError: true } : {}),
                    };
                } catch {
                    // Transport errors can contain response bodies; do not disclose them or config contents.
                    throw new Error(
                        signal.aborted
                            ? "Agent Mail MCP call timed out or was cancelled."
                            : "Agent Mail MCP call failed; its external effect may be unknown. Inspect server state before retrying.",
                    );
                } finally {
                    await client.close().catch(() => {});
                }
            },
        }),
    );

    // Keep the original name so existing conversation selections survive this update.
    return defineExtension({ name: "agent-mail-mcp-health", tools });
}
