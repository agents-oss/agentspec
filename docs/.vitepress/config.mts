import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'AgentSpec',
  description: 'Universal Agent Manifest System',

  // /agentspec/ = default GitHub Pages URL (agents-oss.github.io/agentspec)
  // Change to '/' once a custom domain (agentspec.io) is configured in repo settings
  base: '/agentspec/',
  cleanUrls: true,
  srcExclude: ['**/CLAUDE.md'],

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Quick Start', link: '/quick-start' },
      {
        text: 'GitHub',
        link: 'https://github.com/agents-oss/agentspec',
        target: '_blank',
        rel: 'noopener noreferrer',
      },
    ],

    sidebar: [
      {
        text: 'Getting Started',
        items: [
          { text: 'Quick Start', link: '/quick-start' },
        ],
      },
      {
        text: 'Concepts',
        items: [
          { text: 'The Manifest', link: '/concepts/manifest' },
          { text: 'Health Checks', link: '/concepts/health-checks' },
          { text: 'Runtime Introspection', link: '/concepts/runtime-introspection' },
          { text: 'Compliance', link: '/concepts/compliance' },
          { text: 'Adapters', link: '/concepts/adapters' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Add Tools', link: '/guides/add-tools' },
          { text: 'Add Memory', link: '/guides/add-memory' },
          { text: 'Add Guardrails', link: '/guides/add-guardrails' },
          { text: 'Add Runtime Health', link: '/guides/add-runtime-health' },
          { text: 'Add Push Mode', link: '/guides/add-push-mode' },
          { text: 'CI Integration', link: '/guides/ci-integration' },
          { text: 'E2E Testing', link: '/guides/e2e-testing' },
          { text: 'Migrate an Existing Agent', link: '/guides/migrate-existing-agent' },
          { text: 'Migrate GymCoach', link: '/guides/migrate-gymcoach' },
          { text: 'Migrate OpenAGI', link: '/guides/migrate-openagi' },
          { text: 'Migrate SuperAgent', link: '/guides/migrate-superagent' },
          { text: 'Migrate GPT-Researcher', link: '/guides/migrate-gpt-researcher' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Manifest Schema', link: '/reference/manifest-schema' },
        ],
      },
      {
        text: 'Adapters',
        items: [
          { text: 'LangGraph', link: '/adapters/langgraph' },
          { text: 'CrewAI', link: '/adapters/crewai' },
          { text: 'Mastra', link: '/adapters/mastra' },
          { text: 'AutoGen', link: '/adapters/autogen' },
        ],
      },
    ],

    editLink: {
      pattern: 'https://github.com/agents-oss/agentspec/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/agents-oss/agentspec' },
    ],

    footer: {
      message: 'Released under the Apache 2.0 License.',
      copyright: 'Copyright © 2025-present AgentSpec Contributors',
    },
  },
})
