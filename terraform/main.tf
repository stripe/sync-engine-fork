terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

resource "aws_dsql_cluster" "main" {
  deletion_protection_enabled = false

  tags = {
    Name    = "sync-engine-dsql"
    Project = "sync-engine"
  }
}
