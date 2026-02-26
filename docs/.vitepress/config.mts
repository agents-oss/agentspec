import { defineConfig } from 'vitepress'

// https://vitepress.dev/reference/site-config
export default defineConfig({
  title: 'AgentSpec',
  description: 'Universal Agent Manifest System',

  base: '/',
  cleanUrls: true,

  themeConfig: {
    // https://vitepress.dev/reference/default-theme-config
    nav: [
      { text: 'Home', link: '/' },
      { text: 'Quick Start', link: '/quick-start' },
      {
        text: 'GitHub',
        link: 'https://github.com/agentspec/agentspec',
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
          { text: 'Compliance', link: '/concepts/compliance' },
          { text: 'Adapters', link: '/concepts/adapters' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'Migrate an Existing Agent', link: '/guides/migrate-existing-agent' },
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
      pattern: 'https://github.com/agentspec/agentspec/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/agentspec/agentspec' },
    ],

    footer: {
      message: 'Released under the MIT License.',
      copyright: 'Copyright © 2024-present AgentSpec Contributors',
    },
  },
})
