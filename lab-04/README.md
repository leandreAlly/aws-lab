# Lab 04 — Auto Scaling

An auto-scaling web tier: an internet-facing ALB in public subnets, Apache instances in private subnets managed by an Auto Scaling group that grows on CPU load. Deployed with CloudFormation GitSync. No inbound SSH; the only shell access is Session Manager.

This lab also *deploys* the thing lab-03 only had to **explain**: the regional NAT gateway.

## The task

- ASG with min 1 / desired 1 / max 4, scaling out when average CPU exceeds 30%
- Launch template defined in CloudFormation
- Internet-facing ALB across two AZs, round-robin to instances in private subnets
- A **regional NAT gateway** for outbound package installs
- Apache installed via user data; each instance uniquely identifiable in the browser
- No inbound SSH; everything provisioned as IaC via GitSync

## Architecture

```
                 internet
                    │
              ┌─────▼─────┐  internet-facing, 2 AZs
              │    ALB    │  lab04-alb-sg : 80 from 0.0.0.0/0
              └─────┬─────┘
     ┌──────────────┴──────────────┐   public subnets 10.1.0/24, 10.1.1/24
     │        target group         │   (ALB nodes only - nothing else)
     │     round-robin, HTTP /     │
     └──────────────┬──────────────┘
     ┌──────────────┴──────────────┐   lab04-instance-sg : 80 from ALB SG only
  ┌──▼───────────┐      ┌──────────▼──┐
  │ private AZ-a │      │ private AZ-b│  10.1.10/24, 10.1.11/24
  │  ASG 1..4 instances across both   │
  └──────┬───────┘      └──────┬──────┘
         └────────┬────────────┘
        ┌─────────▼──────────┐
        │ regional NAT gwy   │  one ID, all AZs, no subnet, no EIP
        └─────────┬──────────┘
                 IGW
```

## Regional vs zonal NAT — what changed from lab-03

Lab-03 built the zonal version by hand. Same job, side by side:

| | lab-03 (zonal) | lab-04 (regional) |
|---|---|---|
| NAT gateways | 2, one per AZ | 1, spans all AZs |
| Elastic IPs | 2, declared in the template | 0 — AWS allocates and manages them |
| Public subnets | Required, to host the NATs | Not required (only the ALB uses them here) |
| Private route tables | 2, one per AZ | 1, shared |
| Resources for egress | 8 | 3 |
| AZ alignment | My job, via per-AZ route tables | AWS's job, automatic |
| New AZ added | I edit the template | Auto-expands on detecting an ENI |

Three things the docs make explicit that are easy to get wrong:

- **No `SubnetId`.** A regional NAT gateway isn't hosted in a subnet — it's a standalone VPC-level resource. You give it `VpcId` instead.
- **No Elastic IP.** In automatic mode AWS allocates the EIPs per AZ. Specifying `AvailabilityZoneAddresses` switches it to *manual* mode and **disables auto-expansion**, so omitting it is deliberate.
- **Expansion into a new AZ takes up to 60 minutes.** Until then that AZ's traffic is handled cross-zone. So it's *eventually* zonally-affine, not instantly — worth knowing before claiming it's strictly better than the zonal pair. Here both AZs have instances from deploy time, so it settles during creation.

Pricing is the same per NAT gateway in either mode. Going from two NATs to one halves the hourly charge; regional mode itself isn't a discount, it's an operational simplification. And regional mode **doesn't support private NAT** — that's still zonal-only.

## Scaling policy: why target tracking

The lab says "trigger scale-out when average CPU exceeds 30%". Two ways to build that:

- **Step scaling** — my own CloudWatch alarms and explicit adjustment steps. Precise control ("add exactly one instance per 10% over target"), but scale-in needs a second policy and two more hand-written alarms.
- **Target tracking** *(chosen)* — one resource, AWS manages the alarms. Scale-in comes free, which covers the extra-credit item, and it's what AWS recommends for a single metric like CPU.

The honest trade-off: the thresholds live inside a managed alarm rather than in my template, so they're less visible and I get less control over step size.

**`TargetValue: 30` does not mean "scale out once at 30%".** Target tracking is proportional — it steers the group so *average* CPU sits near 30%:

```
desired = ceil( current_capacity x current_metric / target )
```

So one instance pinned at 100% gives `ceil(1 x 100 / 30) = ceil(3.33) = 4` — straight to max capacity in a single step, not 1→2→3→4. That's expected behaviour, not a misconfiguration.

**Timing, so the demo isn't a surprise:**

| | how long | why |
|---|---|---|
| Scale-out reaction | ~3 min | managed alarm needs ~3 consecutive 1-minute breaching datapoints |
| New instance in service | ~2–3 min | boot, `dnf install httpd` over NAT, 2 health checks at 15s |
| **Scale-out total** | **~5–6 min** | |
| Scale-in | ~15 min below target | deliberately asymmetric — adding capacity is cheap insurance, removing it risks a second spike |

Detailed monitoring (`Monitoring: Enabled` in the launch template) is what buys the 1-minute metrics. On the 5-minute default, scale-out would take noticeably longer.

## Demo runbook

Everything below comes from the stack **Outputs** tab — no placeholders to fill in.

**1. The app is up** — open `AlbUrl`. Each instance renders its own instance ID, AZ, private IP, and a background colour derived from an md5 of its instance ID.

**2. Round-robin across instances** — refresh a few times and the colour changes, or run the `RoundRobinTestCommand` output locally:
```
for i in $(seq 1 10); do curl -s http://<alb-dns> | grep -o "i-[0-9a-f]*"; done
```
Browsers reuse connections, so `curl` in a loop shows the spread more reliably than refreshing.

**3. Trigger scale-out** — Session Manager into any `lab04-web` instance (EC2 → Connect → Session Manager):
```
sudo /usr/local/bin/cpu-burn 600
```
It detaches and returns immediately, so the burn survives the session closing. Then watch EC2 → Auto Scaling Groups → `lab04-asg` → Monitoring, and the target group's Targets tab as new instances appear and turn healthy.

**4. Scale back in** — `sudo cpu-burn-stop`, then wait ~15 minutes.

The stress tool is a dependency-free bash busy loop (one per vCPU), not `stress-ng`. `stress-ng` is installed too when the repo has it, but the demo deliberately doesn't depend on a package resolving.

## Design decisions

- **Instances have no public IP and no SSH key.** The instance security group only accepts port 80 *from the ALB's security group* — membership-based, not a CIDR — so no address on the internet can reach the web server directly. The only path in is the load balancer; the only shell is Session Manager.
- **`HealthCheckType: ELB`, not the EC2 default.** EC2 health checks only notice whether the VM is running, so an instance where Apache crashed stays in the fleet serving errors. With ELB, "stopped answering on `/`" means "replace it".
- **`HealthCheckGracePeriod: 180`.** Without a grace period long enough to cover the Apache install, every new instance gets killed as unhealthy while still installing — the classic ASG death loop of instances launching and terminating forever.
- **`DefaultInstanceWarmup: 120`.** A booting instance reports low CPU, dragging the group average down and risking a scale-in immediately after scaling out. This is the modern replacement for the per-policy `EstimatedInstanceWarmup`.
- **Health check tuned for the demo**: 15s interval + 2 healthy checks puts a new instance in service ~30s after Apache answers, versus ~90s on the defaults. `deregistration_delay` is 30s instead of 300s so scale-in completes visibly.
- **IMDSv2 enforced** (`HttpTokens: required`), not merely available — IMDSv1's unauthenticated metadata GET is the mechanism behind the SSRF→instance-credential-theft attack.
- **`MetricsCollection` enabled** so ASG group metrics reach CloudWatch. Not needed for scaling to work, but it's what makes the 1→4 stair-step graph exist.
- **One template again.** ~30 resources, one lifecycle, same reasoning as lab-03: nested stacks would force the children into S3 and break the GitSync push-to-deploy workflow, and cross-stack exports solve a lifecycle-decoupling problem this lab doesn't have.

## Notes / what I learned

- **Launch templates, not launch configurations.** Launch configurations are deprecated and can't be created in new accounts; any tutorial using `AWS::AutoScaling::LaunchConfiguration` is stale.
- `IamInstanceProfile` takes `{ Name: ... }` in a launch template but a bare string on `AWS::EC2::Instance` — different shapes for the same idea.
- **`PropagateAtLaunch: true`** or the ASG's tags stay on the ASG and never reach the instances. Three separate tag surfaces here: launch template, launch-template `TagSpecifications`, and ASG tags.
- Target tracking policies must not carry `ScalingAdjustment` or `Cooldown` — those belong to simple/step policies, and mixing them is a template error.
- The `!Sub` brace discipline from lab-03, applied on purpose this time: every shell variable in user data is written brace-free (`$IID`, `$DURATION`) so `!Sub` only ever sees `${LabName}`. The escape hatch, if a literal `${X}` were ever needed, is `${!X}`.
- A demo load generator should **detach**. The obvious `... & wait` version blocks the Session Manager session and dies with it — the scale-out then stops halfway through, silently.

## Sub-lab: the managed version of this same problem

[`todo-app-bean-stalk/`](todo-app-bean-stalk/README.md) solves the same brief — a public, self-healing web tier — by handing it to Elastic Beanstalk instead of assembling it. Everything above (launch template, ASG, ALB, target group, listener, scaling policy, security groups) collapses into a handful of EB option settings, and the effort moves to the delivery pipeline: a Node.js app on DynamoDB, source bundles versioned in S3, and GitHub Actions deploying on every push through an OIDC role with no stored AWS keys.

Reading the two side by side is the actual lesson. This lab shows what the managed platform is doing for you; the sub-lab shows what you hand over to stop doing it yourself — and where that abstraction leaks (`aws:autoscaling:launchconfiguration` is still the namespace name, years after launch configurations were deprecated).

## Screenshots

*(added after the live deployment)*
