# AWS Labs

Hands-on AWS labs I'm working through, one directory per lab. Everything is deployed as code (CloudFormation + GitSync — a `git push` to this repo is the deploy), and every lab has its own README with what I built, what broke, and what I actually learned. The broken parts are documented on purpose: that's where the learning was.

## Labs

| # | Lab | Services | What it really taught me |
|---|-----|----------|--------------------------|
| 01 | [IAM users, groups and a shared temp password](lab-01/README.md) | IAM, Secrets Manager, CloudFormation GitSync | Explicit Deny beats everything, trust policies control which roles even show up in dropdowns, and one wrong file extension can 404 a whole deployment |
| 02 | [Testing IAM user permissions (CloudShell + CLI)](lab-02/Tasks.md) | IAM, S3, EC2 | IAM is global, almost everything else is regional; `sts get-caller-identity` and `configure get region` before doubting anything else; a role's trust policy decides *who can assume it*, its permission policies decide *what it can do* |


## How this repo is organized

```
lab-XX/
  practice.yml        # the CloudFormation template
  deployment.yaml     # GitSync deployment file (template path + parameters)
  README.md           # task, solution notes, what broke
  screenshots/        # evidence
```

Each lab is self-contained: its own template, its own deployment file, its own stack. Deleting a lab is deleting a directory (and its stack).

## Conventions I follow

- `cfn-lint` before every push. It catches invalid templates in seconds. It does not catch a valid template doing the wrong thing — that one is on me, and it has bitten me already.
- One region per lab, chosen deliberately. Half my debugging time in lab 01 was resources being "missing" because the CLI, the console, or I was pointed at the wrong region or the wrong account.
- Lab stacks get torn down when the lab is done. Secrets Manager secrets need a force-delete if the stack will be recreated soon — deleted secrets linger in a recovery window and block recreation by name.

## Recurring lessons (updated as they recur)

- `aws sts get-caller-identity` and `aws configure get region` before doubting anything else. Every CLI call runs as *some identity* in *some region*, and when a resource that definitely exists "isn't found", one of those two is wrong.
- IAM is global, almost everything else is regional.
- A role's trust policy decides *who can assume it*; its permission policies decide *what it can do*. Console dropdowns filter by trust policy, so a role that exists can still be invisible.
- The console needs far more permissions than the task suggests. A user with only `RunInstances` can't actually use the launch wizard — every dropdown in it is a Describe call that has to be allowed too.
- Green status means the last operation succeeded, not that the system contains what you think it does. Check the actual inventory (Resources tab, `list-*` commands).