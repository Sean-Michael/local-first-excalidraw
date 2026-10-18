# Infrastructure and network topology

Infrastructure diagrams show where software runs and how traffic reaches it: cloud accounts, regions, networks, subnets, clusters, load balancers, gateways and the managed services in between. This is the physical view in 4+1, and the deployment view in arc42 (section 7) and C4.

**Use it when** the question is about:

- how a request reaches a service
- what's public and what's private
- what's redundant and where the single points of failure are
- what a terraform, Helm or compose change touches
- how environments differ

**Don't use it** to explain what the software does. Use a container diagram for that, and keep the two in step by using the same names.

## Notation

There is no standard. These conventions are widely shared:

- **Nesting shows containment:** account or subscription › region › VPC/VNet › availability zone › subnet › instance, node or pod. Draw each level as a labelled boundary.
- **Public and private** subnets are marked by colour *and* label, never colour alone.
- **Icons:** vendor icon sets (AWS, Azure, GCP, Kubernetes) are recognisable. C4's rule applies: every icon in the diagram appears in the legend, or carries a text label.
- **Edges:** traffic direction and protocol/port (`HTTPS :443`, `gRPC :50051`, `TCP :5432`). Use a distinct style (dashed) for control-plane or management traffic, replication, or VPN.
- **Redundancy:** show two instances (or a `×3` label) where it matters, rather than one box that hides it.
- **Network devices** (classic topology): router, switch, firewall, VPN concentrator, and clients, each as an icon with a hostname or role label.

## Excalidraw recipe

1. `list_shapes` with queries like `"load balancer"`, `"server"`, `"firewall"`, `"database"`, `"cdn"` or `"cloud"`. Product names work too (`"postgres"`, `"s3"`, `"kafka"`, `"redis"`, `"mongo"`, `"api gateway"`, `"kubernetes"`): each built-in shape's description starts with what it stands for. Built-in keys that usually exist:
   - `system-design-components/load-balancer`
   - `system-design-components/cdn`
   - `system-design-components/dns`
   - `system-design-components/application-server`
   - `system-design-components/multi-instance-server`
   - `system-design-components/relational-db`
   - `system-design-components/object-storage` (S3, blob storage)
   - `system-design-components/document-db` (MongoDB, DynamoDB)
   - `system-design-components/key-value-cache` (Redis, Memcached)
   - `system-design-components/message-queue`
   - `system-design-components/auth-iam`
   - `network-topology-icons/firewall`
   - `network-topology-icons/router`
   - `network-topology-icons/switch`
   - `network-topology-icons/server`
   - `network-topology-icons/client`

   If the user has a cloud-vendor `.excalidrawlib` in the project, `list_shapes` finds it. Prefer it.
2. Use `create_diagram` with `direction: "LR"` (internet on the left, data on the right). Give the innermost boundary (subnet, cluster, namespace) a group. Use library shapes as node `shape`s. The label replaces the icon's own caption (or goes under the icon), so make it the resource name from the IaC (`"aws_lb.public"` or `"alb-public"`) plus a role.

```json create_diagram
{
  "path": "docs/diagrams/infra-prod",
  "direction": "LR",
  "title": "Infrastructure: production (eu-west-1)",
  "nodes": [
    { "id": "users", "label": "Internet users", "shape": "network-topology-icons/client" },
    { "id": "alb", "label": "alb-public\n[ALB, HTTPS :443]", "shape": "system-design-components/load-balancer", "group": "public" },
    { "id": "api", "label": "shop-api ×3\n[ECS Fargate]", "shape": "system-design-components/multi-instance-server", "group": "private" },
    { "id": "rds", "label": "orders-db\n[RDS PostgreSQL, Multi-AZ]", "shape": "system-design-components/relational-db", "group": "data" }
  ],
  "groups": [
    { "id": "public", "label": "Public subnets (2 AZ)" },
    { "id": "private", "label": "Private app subnets (2 AZ)" },
    { "id": "data", "label": "Private data subnets (2 AZ)" }
  ],
  "edges": [
    { "from": "users", "to": "alb", "label": "HTTPS :443" },
    { "from": "alb", "to": "api", "label": "HTTP :8080" },
    { "from": "api", "to": "rds", "label": "TCP :5432" }
  ]
}
```

   Each subnet group sits in its own layer, so the frames don't overlap. A node that isn't in a group but shares a layer with one (a CDN beside the load balancer, say) ends up next to the frame, and its label can collide with the frame's name. Give such nodes their own group (`"Edge (global)"`), or draw that path as a second diagram.
3. Add the outer boundaries (VPC, region, account) as dashed rectangles around the frames, with a text label each, using the `add_elements` pattern in `c4.md` (Deployment). Use gray for these structural boundaries, and keep red for security boundaries.
4. Add a legend for the icons if any aren't labelled (`visual-principles.md`).

For a classic LAN or WAN topology, use the same approach with network-topology icons, `direction: "TB"` (core router on top, access switches, then hosts), and VLANs or sites as groups. Label the links with speed or medium where it matters (`"10 GbE"`, `"IPsec VPN"`).

For Kubernetes, use one group per namespace (or per node, if the question is about scheduling). Label workloads `"Deployment: api ×3"`, and draw Services and Ingresses as their own nodes so the traffic path is explicit.

## Common mistakes

- **Every resource drawn.** Security groups, IAM roles and route tables usually don't belong unless the question is about them. Put them in a note.
- **Icons without labels,** or icons from three different vendors' styles mixed together.
- **Nesting implied by position only.** Draw the VPC and subnet boundaries.
- **Single boxes hiding redundancy or AZ spread** when the question is about availability.
- **Names that don't match the IaC.** Readers can't find the resource. Use the terraform/Helm names, and link nodes to the file that defines them (`"code": "infra/alb.tf"`).
- **One diagram for all environments.** Draw one per environment, or label clearly what differs.
