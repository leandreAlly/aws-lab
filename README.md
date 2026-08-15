# AWS Labs

Hands-on AWS labs I'm working through, one directory per lab. Everything is deployed as code (CloudFormation + GitSync — a `git push` to this repo is the deploy), and every lab has its own README with what I built, what broke, and what I actually learned. The broken parts are documented on purpose: that's where the learning was.

## Labs

| # | Lab | Services | What it really taught me |
|---|-----|----------|--------------------------|
| 01 | [IAM users, groups and a shared temp password](lab-01/README.md) | IAM, Secrets Manager, CloudFormation GitSync | Explicit Deny beats everything, trust policies control which roles even show up in dropdowns, and one wrong file extension can 404 a whole deployment |
| 02 | [Testing IAM user permissions (CloudShell + CLI)](lab-02/Tasks.md) | IAM, S3, EC2 | IAM is global, almost everything else is regional; `sts get-caller-identity` and `configure get region` before doubting anything else; a role's trust policy decides *who can assume it*, its permission policies decide *what it can do* |
| 03 | [Securely deploying resources in a VPC](lab-03/README.md) | VPC, EC2, NAT Gateway, SSM Session Manager, CloudFormation GitSync | A subnet is public because of its *route table*, not its name; NAT gateways are zonal, so high availability is my job (one per AZ, one private route table per AZ); Session Manager needs zero inbound ports — the agent dials out |
| 04 | [Auto Scaling](lab-04/README.md) | EC2 Auto Scaling, ALB, Launch Templates, Regional NAT Gateway, CloudWatch | Deployed the regional NAT gateway lab-03 only had to explain — 8 egress resources become 3; target tracking is *proportional*, so one instance at 100% CPU jumps straight to max, not one step at a time; a demo load generator must detach, or it dies with the session that started it |
| 04b | [Elastic Beanstalk continuous delivery](lab-04/todo-app-bean-stalk/README.md) | Elastic Beanstalk, S3, DynamoDB, GitHub Actions, IAM OIDC | A managed policy whose *name* fits the use case is not one whose *resources* match my names — `AWSElasticBeanstalkWebTier` only covers buckets called `elasticbeanstalk-*`; CloudFormation owning `VersionLabel` means a later stack update silently rolls the app back; `wait environment-updated` returns on Ready, and Ready includes degraded |
| 05 | [Push a Docker image to ECR](lab-05/README.md) | ECR, Docker, GitHub Actions, IAM OIDC, CloudFormation GitSync | CloudFormation never checks that a federated principal exists, so a role trusting a deleted OIDC provider creates cleanly and fails only when a real token shows up; GitHub's default `run:` shell is `bash -e` with no `pipefail`, which makes every `curl \| jq` health check silently incapable of failing; immutable tags and a mandated fixed tag cannot coexist |


## How this repo is organized

```
lab-XX/
  practice.yml        # the CloudFormation template
  deployment.yaml     # GitSync deployment file (template path + parameters)
  README.md           # task, solution notes, what broke
  screenshots/        # evidence
```

Each lab is self-contained: its own template, its own deployment file, its own stack. Deleting a lab is deleting a directory (and its stack).

Lab 04 has a sub-lab, `lab-04/todo-app-bean-stalk/`, which follows the same shape but adds an application: `app/` holds the Node.js source, and the deploy path is split in two. CloudFormation GitSync still owns the infrastructure, while `.github/workflows/deploy-beanstalk.yml` owns application releases. Workflows have to live at the repo root — GitHub won't run them from a subdirectory — so that file is path-filtered to the sub-lab and never fires for the other labs.

Lab 05 (`lab-05/`) follows that same infrastructure/application split, with one deliberate exception: `.github/workflows/push-ecr.yml` has **no path filter**, because that lab's brief requires a pipeline triggering on every push to the repository. So a push touching only `lab-01/README.md` still builds and publishes a container image. It's the one place in this repo where a lab's requirements beat the house convention, and it's recorded rather than quietly tolerated.

## Conventions I follow

- `cfn-lint` before every push. It catches invalid templates in seconds. It does not catch a valid template doing the wrong thing — that one is on me, and it has bitten me already.
- One region per lab, chosen deliberately. Half my debugging time in lab 01 was resources being "missing" because the CLI, the console, or I was pointed at the wrong region or the wrong account.
- Lab stacks get torn down when the lab is done. Secrets Manager secrets need a force-delete if the stack will be recreated soon — deleted secrets linger in a recovery window and block recreation by name.
- NAT gateways bill by the hour whether or not anything uses them (~$0.045/h each, plus data). They are the most expensive idle resource in these labs, so a finished lab is a deleted stack, not a stopped instance.

## Recurring lessons (updated as they recur)

- `aws sts get-caller-identity` and `aws configure get region` before doubting anything else. Every CLI call runs as *some identity* in *some region*, and when a resource that definitely exists "isn't found", one of those two is wrong.
- IAM is global, almost everything else is regional.
- A role's trust policy decides *who can assume it*; its permission policies decide *what it can do*. Console dropdowns filter by trust policy, so a role that exists can still be invisible.
- The console needs far more permissions than the task suggests. A user with only `RunInstances` can't actually use the launch wizard — every dropdown in it is a Describe call that has to be allowed too.
- Green status means the last operation succeeded, not that the system contains what you think it does. Check the actual inventory (Resources tab, `list-*` commands).
- GitSync runs as **two different identities**: the sync role that talks to CloudFormation, and the stack execution role that CloudFormation assumes to build the resources. An `AccessDenied` means nothing until you read *which* role it names — they need completely different permissions.
- Scope IAM policy resources to a *pattern* the next lab will match (`stack/lab-*`), not to one literal name. Every hardcoded resource ARN is a permission error waiting for the next stack.