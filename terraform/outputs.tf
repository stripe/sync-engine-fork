output "cluster_endpoint" {
  description = "DSQL cluster endpoint (use as hostname for pg connections)"
  value       = "${aws_dsql_cluster.main.identifier}.dsql.${var.region}.on.aws"
}

output "cluster_arn" {
  description = "DSQL cluster ARN"
  value       = aws_dsql_cluster.main.arn
}

output "region" {
  description = "AWS region"
  value       = var.region
}
