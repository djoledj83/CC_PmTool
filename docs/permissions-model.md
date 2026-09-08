# Permissions Model

# Overview

The platform uses Role-Based Access Control (RBAC) with project-scoped permissions.

Permissions are enforced server-side only.

Frontend permissions are used only for UI visibility and must never be trusted for authorization.

The system supports:
- organization-level roles
- project-level roles
- resource ownership rules
- action-based permissions

---

# Permission Architecture

Permissions are evaluated in this order:

1. Authentication
2. Organization access
3. Project membership
4. Role permissions
5. Ownership validation
6. Resource state validation

All checks must pass before action execution.

---

# Core Concepts

## Organization

Top-level tenant boundary.

Users belong to one or more organizations.

Organization data must remain isolated.

---

## Project

Projects belong to organizations.

Users may have different permissions based on add functionalities.

We can add different functionalities by checkboxes by admin role

---

## Resource Ownership

Some resources have ownership rules.

Examples:
- task creator
- comment author
- release creator
- uploaded file owner

Ownership does not override RBAC restrictions.

---

# Organization Roles

## Super Admin

Full system access.

Permissions:
- manage organizations
- manage billing
- manage global settings
- manage all users
- view audit logs
- impersonate users

Restrictions:
- cannot bypass audit logging

---

## Organization Manager

Administrative access within organization.

Permissions:
- create projects
- manage members
- manage project visibility
- manage organization settings
- view reports

Restrictions:
- cannot access platform-level administration

---

## Organization Member

Standard organization access.

Permissions:
- access assigned projects
- participate in workflows

Restrictions:
- cannot manage organization settings
- cannot access unassigned projects

---

# Project Roles

## Project Owner

Highest project-level authority.

Permissions:
- manage project settings
- archive/delete project
- manage roles
- manage workflows
- manage releases
- access all project resources
- create/edit tasks
- assign tasks
- manage sprints
- manage releases
- approve deployments
- view reports

Restrictions:
- cannot bypass organization restrictions

---

## Project Manager

Workflow and team management.

Permissions:
- 

Restrictions:
- 

---

## User

Read-only access.

Permissions:
- view projects
- view tasks
- view reports
- close assigned task and subtasks

Restrictions:
- cannot modify data

---

# Permission Matrix

| Action | Owner | Manager | User |
|---|---|---|---|---|---|
| View Project | YES | YES | | YES |
| Edit Project Settings | YES | YES | NO |
| Manage Members | YES | YES | NO |
| Create Task | YES | YES | NO |
| Edit Any Task | YES | YES | NO |
| Edit Own Task | YES | YES | YES |
| Delete Task | YES | YES | NO |
| Log Time | YES | YES | NO |
| Manage Releases | YES | YES | NO |
| Deploy Release | YES | YES | NO |
| View Reports | YES | YES | READONLY |

---

# Resource-Level Rules

# Tasks

## Edit Rules

Users may edit:
- tasks assigned to them just status done or not done
- tasks they created
- tasks allowed by role permissions

Restricted fields:
- release linkage
- workflow configuration
- archived state

---

## Delete Rules

Task deletion:
- soft-delete only
- activity logs preserved
- time entries preserved

Only:
- project owners
- project managers

may delete tasks.

---

# Comments

Users may:
- edit own comments
- delete own comments within limited time window

---

# Time Tracking Rules

## Active Timers

Rules:
- one active timer per user globally
- overlapping entries forbidden
- stopped timers immutable after approval

---

## Time Editing

Users may edit:
- own unapproved entries

Managers may edit:
- 

Audit logs required for all modifications.

---

# Release Management Rules

## Release Creation

Allowed:
- project owners
- project managers

---

## Release Approval

Requires:
- QA approval
- deployment approval

Approval chain enforced server-side.

---

## Deployment Actions

Deployment permissions restricted to:
- release managers
- project owners

All deployment actions audited.

---

# File & Attachment Rules

Users may access:
- files belonging to accessible projects

Restrictions:
- signed URLs expire
- direct storage access forbidden
- uploads validated server-side

---

# API Authorization Rules

Every protected endpoint must validate:

1. authenticated user
2. organization membership
3. project access
4. role permissions
5. ownership rules
6. resource state

No endpoint may trust frontend-provided permissions.

---

# Websocket Authorization

Websocket subscriptions require:
- authenticated session
- valid project membership

Events must only be broadcast to authorized users.

Sensitive events:
- releases
- deployments
- private comments
- audit actions

must use restricted channels.

---

# Audit Logging Rules

Audit logs required for:
- role changes
- deployment actions
- release approvals
- project deletion
- permission modifications
- sensitive edits

Audit logs are immutable.

---

# Security Constraints

Critical rules:
- authorization enforced server-side only
- ownership checks mandatory
- tenant isolation mandatory
- object ID validation mandatory
- privilege escalation prevention required

---

# Known Risks / Technical Debt

## Current Risks

- legacy endpoints missing ownership middleware
- inconsistent permission checks in websocket handlers
- 

---

# Planned Improvements

- centralized permission engine
- declarative permission policies
- permission caching
- audit dashboard