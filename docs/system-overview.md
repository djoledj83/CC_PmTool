# System Overview

## Purpose

This platform is an enterprise-grade project management system.

Core features:
- project management
- task tracking
- time tracking
- release management
- team collaboration
- notifications
- role-based permissions
- activity tracking
- reporting

The system supports multi-project workflows and real-time updates.

---

# Main Modules

## Authentication & Authorization

Responsible for:
- login
- JWT/session management
- RBAC
- project-level permissions

---

## Project Management

Responsible for:
- project lifecycle
- project members
- project settings
- project visibility
- project metadata

---

## Task Management

Responsible for:
- task CRUD
- task lifecycle
- assignees
- comments
- attachments
- labels
- priorities
- dependencies

---

## Time Tracking

Responsible for:
- time entries
- active timers
- manual logging
- reporting
- billable tracking

---

## Release Management

Responsible for:
- release planning
- deployment tracking
- release notes
- approval workflows
- release statuses

---

## Notification System

Responsible for:
- in-app notifications
- websocket updates
- email notifications
- event-driven alerts

---

# Architecture Overview

Frontend:
- React application
- realtime websocket updates
- optimistic UI updates
- centralized state management

Backend:
- Node JS
- REST API
- websocket gateway
- modular service architecture
- queue/event-driven background jobs

Database:
- relational database
- transactional operations
- audit logging
- PostgreSQL

---

# Core Business Rules

## Permissions

- users only access assigned projects
- project admins manage members
- RBAC enforced server-side only
- frontend permissions are not trusted

---

## Task Lifecycle

Task states:
- backlog
- todo
- in_progress
- review
- testing
- done
- archived

Invalid transitions must be rejected.

---

## Time Tracking Rules

- only one active timer per user
- time entries cannot overlap
- deleted tasks preserve historical time logs

---

## Release Rules

- releases require approval before deployment
- deployments create audit logs
- release notes are immutable after release

---

# Real-Time System

Websocket events are used for:
- task updates
- comments
- notifications
- timer synchronization
- release status updates
- chatting in application

Frontend must remain synchronized with backend state.

---

# Important Technical Constraints

- avoid duplicated business logic
- preserve transactional consistency
- avoid websocket desynchronization
- maintain audit history
- preserve backward API compatibility

---

# Known Risks / Technical Debt

- notification system requires optimization
- websocket reconnect handling needs improvement
- some legacy services contain duplicated validation logic